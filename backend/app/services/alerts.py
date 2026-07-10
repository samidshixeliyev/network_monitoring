"""
Alert + escalation engine.

Runs in the collector process. Each cycle it looks for devices that have been in
alarm long enough and notifies on every configured channel (email / webhook /
Telegram / SMS — see app/services/notify.py) — once per outage (deduped via
`alert_notified_at`), with a recovery notification when they come back.

Also watches for DEGRADED links: a device that still answers pings but drops
more than ALERT_LOSS_PCT of packets over the window (per-check sent/received
counts in ping_history). Deduped in-memory per device with a cooldown — fine
because the collector is a single process.

Suppression rules (avoid alarm storms / noise):
  * muted devices                          → never alert
  * devices under maintenance              → never alert
  * ALERT_CRITICAL_ONLY → only is_critical → alert
  * parent is down (dependency)            → suppress child (collateral outage)
"""
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, text

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, EventLog
from app.models.device import DeviceStatus
from app.models.event_log import EventType
from app.schemas.device import serialize_device
from app.services import notify, state_cache
from app.services.audit import add_audit

logger = logging.getLogger(__name__)

# Degraded-link dedup: device_id → when we last notified (UTC).
_loss_notified_at: dict[uuid.UUID, datetime] = {}


def _in_maintenance(d: Device, now: datetime) -> bool:
    return d.maintenance_until is not None and now < d.maintenance_until


def _in_alarm(d: Device) -> bool:
    return d.current_status == DeviceStatus.offline or d.service_ok is False


async def _outage_started_at(session, device_id) -> datetime | None:
    """Start of the current outage = latest went_offline event."""
    return await session.scalar(
        select(EventLog.created_at)
        .where(EventLog.device_id == device_id, EventLog.event_type == EventType.went_offline)
        .order_by(EventLog.created_at.desc())
        .limit(1)
    )


def _body(d: Device, kind: str, extra: str = "") -> str:
    loc = f"\nLocation: {d.location_text}" if d.location_text else ""
    return (
        f"Device: {d.vendor_name}\nIP: {d.ip_address}{loc}\n"
        f"Status: {d.current_status.value}"
        f"{' / service ' + ('OK' if d.service_ok else 'FAILING') if d.service_ok is not None else ''}\n"
        f"{extra}\nEvent: {kind}\nTime: {datetime.now(timezone.utc).isoformat()}\n"
    )


async def _notify(d: Device, subject: str, body: str, kind: str) -> str:
    results = await notify.send_alert(subject, body, kind=kind, device_ip=str(d.ip_address))
    return notify.summarize(results)


async def _alert_tick() -> None:
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        devices = list(await session.scalars(select(Device)))
        by_id = {d.id: d for d in devices}

        for d in devices:
            if not d.is_enabled:
                continue

            recovered = (not _in_alarm(d)) and d.alert_notified_at is not None
            if recovered:
                summary = await _notify(
                    d, f"[RESOLVED] {d.vendor_name} ({d.ip_address})", _body(d, "recovered"), "recovered"
                )
                add_audit(
                    session, None, "alert.recovered",
                    target_type="device", target_id=str(d.id), detail=summary,
                )
                d.alert_notified_at = None
                await session.commit()
                await session.refresh(d)
                await state_cache.upsert_device(serialize_device(d))
                continue

            if not _in_alarm(d) or d.alert_notified_at is not None:
                continue
            if d.is_muted or _in_maintenance(d, now):
                continue
            if settings.ALERT_CRITICAL_ONLY and not d.is_critical:
                continue
            # Dependency suppression: parent down → child outage is collateral.
            parent = by_id.get(d.parent_id) if d.parent_id else None
            if parent is not None and parent.current_status == DeviceStatus.offline:
                continue

            # Down long enough? (service-only alarms fire immediately.)
            if d.current_status == DeviceStatus.offline:
                started = await _outage_started_at(session, d.id)
                if started is None or (now - started).total_seconds() < settings.ALERT_AFTER_SECONDS:
                    continue
                extra = f"Down for {int((now - started).total_seconds())}s"
            else:
                extra = f"Service check failing: {d.service_detail or ''}"

            summary = await _notify(
                d, f"[ALERT] {d.vendor_name} ({d.ip_address}) DOWN", _body(d, "alarm", extra), "alarm"
            )
            d.alert_notified_at = now
            add_audit(
                session, None, "alert.sent",
                target_type="device", target_id=str(d.id), detail=summary,
            )
            await session.commit()
            await session.refresh(d)
            await state_cache.upsert_device(serialize_device(d))
            logger.info("alert for %s (%s): %s", d.ip_address, d.vendor_name, summary)


# ── Degraded-link check (partial packet loss while nominally online) ─────────
async def _loss_tick() -> None:
    if settings.ALERT_LOSS_PCT <= 0:
        return
    now = datetime.now(timezone.utc)
    window = settings.ALERT_LOSS_WINDOW_MINUTES
    async with AsyncSessionLocal() as session:
        # Interval literal is server-controlled (int), same pattern as /history.
        rows = (
            await session.execute(
                text(
                    f"""
                    SELECT device_id, sum(sent) AS sent, sum(received) AS received
                    FROM ping_history
                    WHERE ts >= now() - INTERVAL '{int(window)} minutes' AND sent IS NOT NULL
                    GROUP BY device_id
                    HAVING sum(sent) >= 6
                    """
                )
            )
        ).all()

        lossy = {}
        for device_id, sent, received in rows:
            loss = (1 - int(received) / int(sent)) * 100
            if loss >= settings.ALERT_LOSS_PCT:
                lossy[device_id] = round(loss, 1)
        if not lossy:
            return

        devices = list(await session.scalars(select(Device).where(Device.id.in_(lossy))))
        for d in devices:
            if not d.is_enabled or d.is_muted or _in_maintenance(d, now):
                continue
            if settings.ALERT_CRITICAL_ONLY and not d.is_critical:
                continue
            # A fully-down device is the outage alert's job, not a "degraded" one.
            if d.current_status == DeviceStatus.offline:
                continue
            last = _loss_notified_at.get(d.id)
            if last and (now - last).total_seconds() < settings.ALERT_LOSS_COOLDOWN_MINUTES * 60:
                continue

            loss = lossy[d.id]
            extra = f"Packet loss {loss}% over the last {window} min (threshold {settings.ALERT_LOSS_PCT}%)"
            summary = await _notify(
                d, f"[DEGRADED] {d.vendor_name} ({d.ip_address}) {loss}% loss",
                _body(d, "degraded", extra), "degraded",
            )
            _loss_notified_at[d.id] = now
            add_audit(
                session, None, "alert.degraded",
                target_type="device", target_id=str(d.id), detail=f"loss {loss}% — {summary}",
            )
            await session.commit()
            logger.info("degraded-link alert for %s (%s%% loss): %s", d.ip_address, loss, summary)


async def alert_loop() -> None:
    if not settings.ALERT_ENABLED:
        logger.info("alert engine disabled (ALERT_ENABLED=false)")
        return
    logger.info(
        "alert engine started — after=%ds, critical_only=%s, every %ds, channels=%s, loss_pct=%s",
        settings.ALERT_AFTER_SECONDS, settings.ALERT_CRITICAL_ONLY,
        settings.ALERT_CHECK_INTERVAL_SECONDS,
        ",".join(notify.active_channels()) or "NONE",
        settings.ALERT_LOSS_PCT or "off",
    )
    import asyncio

    while True:
        try:
            await _alert_tick()
        except Exception as exc:  # noqa: BLE001
            logger.error("alert tick error: %s", exc, exc_info=True)
        try:
            await _loss_tick()
        except Exception as exc:  # noqa: BLE001
            logger.error("loss tick error: %s", exc, exc_info=True)
        await asyncio.sleep(settings.ALERT_CHECK_INTERVAL_SECONDS)
