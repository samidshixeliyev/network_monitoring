"""
Alert + escalation engine (email).

Runs in the collector process. Each cycle it looks for devices that have been in
alarm long enough and notifies by email — once per outage (deduped via
`alert_notified_at`), with a recovery email when they come back.

Suppression rules (avoid alarm storms / noise):
  * muted devices                          → never alert
  * devices under maintenance              → never alert
  * ALERT_CRITICAL_ONLY → only is_critical → alert
  * parent is down (dependency)            → suppress child (collateral outage)
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, EventLog
from app.models.device import DeviceStatus
from app.models.event_log import EventType
from app.schemas.device import serialize_device
from app.services import state_cache
from app.services.audit import add_audit
from app.services.email import send_email

logger = logging.getLogger(__name__)


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
                await send_email(f"[RESOLVED] {d.vendor_name} ({d.ip_address})", _body(d, "recovered"))
                add_audit(session, None, "alert.recovered", target_type="device", target_id=str(d.id))
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

            sent = await send_email(f"[ALERT] {d.vendor_name} ({d.ip_address}) DOWN", _body(d, "alarm", extra))
            d.alert_notified_at = now
            add_audit(
                session, None, "alert.sent", target_type="device", target_id=str(d.id),
                detail=("email ok" if sent else "email failed"),
            )
            await session.commit()
            await session.refresh(d)
            await state_cache.upsert_device(serialize_device(d))
            logger.info("alert for %s (%s) sent=%s", d.ip_address, d.vendor_name, sent)


async def alert_loop() -> None:
    if not settings.ALERT_ENABLED:
        logger.info("alert engine disabled (ALERT_ENABLED=false)")
        return
    logger.info(
        "alert engine started — after=%ds, critical_only=%s, every %ds",
        settings.ALERT_AFTER_SECONDS, settings.ALERT_CRITICAL_ONLY,
        settings.ALERT_CHECK_INTERVAL_SECONDS,
    )
    import asyncio

    while True:
        try:
            await _alert_tick()
        except Exception as exc:  # noqa: BLE001
            logger.error("alert tick error: %s", exc, exc_info=True)
        await asyncio.sleep(settings.ALERT_CHECK_INTERVAL_SECONDS)
