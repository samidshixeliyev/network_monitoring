import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_permission
from app.core.config import settings
from app.core.permissions import ACK, EDIT_CONFIG, EDIT_DEVICE, MUTE, SSH
from app.db.session import get_db
from app.models import Device, EventLog, User
from app.models.device import DeviceStatus
from app.models.event_log import EventType
from app.schemas.device import (
    DeviceCreate,
    DeviceRead,
    DeviceSimulate,
    DeviceUpdate,
    SshCheckResult,
    serialize_device,
)
from app.services import state_cache
from app.services.audit import add_audit
from app.services.ssh_collector import collect_device

router = APIRouter(prefix="/api/devices", tags=["devices"])
logger = logging.getLogger(__name__)


@router.get("", response_model=list[DeviceRead])
async def list_devices(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Dashboard snapshot. Served FROM REDIS so many simultaneous logins don't
    hammer Postgres. On a cold cache (e.g. fresh Redis) it loads from the DB
    once and warms the cache. If Redis is unavailable, it falls back to the DB
    so the dashboard degrades gracefully instead of 500-ing."""
    try:
        if await state_cache.cache_is_current():
            cached = await state_cache.get_all_devices()
            if cached:
                return cached
    except Exception as exc:  # noqa: BLE001 — Redis hiccup → fall back to DB
        logger.warning("device snapshot cache read failed, using DB: %s", exc)

    result = await db.scalars(select(Device).order_by(Device.created_at))
    devices = list(result.all())
    try:
        await state_cache.warm_devices([serialize_device(d) for d in devices])
    except Exception as exc:  # noqa: BLE001
        logger.warning("cache warm after DB read failed: %s", exc)
    return devices


@router.get("/snapshot")
async def devices_snapshot(_: User = Depends(get_current_user)) -> list[dict]:
    """Lightweight status-only snapshot from Redis (id/status/last_checked_at).
    Useful after a WebSocket reconnect to resync without re-fetching everything."""
    devices = await state_cache.get_all_devices()
    return [
        {
            "device_id": d["id"],
            "status": d["current_status"],
            "last_checked_at": d.get("last_checked_at"),
        }
        for d in devices
    ]


@router.post("", response_model=DeviceRead, status_code=status.HTTP_201_CREATED)
async def create_device(
    body: DeviceCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> Device:
    device = Device(**body.model_dump(), created_by=current_user.id)
    db.add(device)
    add_audit(
        db, current_user, "device.create",
        target_type="device", detail=f"{device.vendor_name} ({device.ip_address})",
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A device with this IP address already exists")
    await db.refresh(device)
    await state_cache.upsert_device(serialize_device(device))
    return device


@router.get("/{device_id}", response_model=DeviceRead)
async def get_device(
    device_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.patch("/{device_id}", response_model=DeviceRead)
async def update_device(
    device_id: uuid.UUID,
    body: DeviceUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(device, field, value)
    add_audit(
        db, current_user, "device.update",
        target_type="device", target_id=str(device_id),
        detail=", ".join(k for k in changes if k != "ssh_password") or "(no fields)",
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A device with this IP address already exists")
    await db.refresh(device)
    await state_cache.upsert_device(serialize_device(device))
    return device


@router.post("/{device_id}/simulate", response_model=DeviceRead)
async def simulate_device_status(
    device_id: uuid.UUID,
    body: DeviceSimulate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_CONFIG)),
) -> Device:
    """Manually mark a device online/offline (testing). Logs an event and
    broadcasts the change exactly like the real ping loop would."""
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    new_status = DeviceStatus(body.status)
    now = datetime.now(timezone.utc)
    prev_status = device.current_status

    device.last_checked_at = now
    device.current_status = new_status
    device.consecutive_failures = 0 if new_status == DeviceStatus.online else settings.FLAP_THRESHOLD

    if new_status != prev_status:
        event_type = (
            EventType.came_online
            if new_status == DeviceStatus.online
            else EventType.went_offline
        )
        db.add(EventLog(device_id=device.id, event_type=event_type))

    add_audit(
        db, current_user, "device.simulate",
        target_type="device", target_id=str(device_id), detail=f"→ {new_status.value}",
    )
    await db.commit()
    await db.refresh(device)

    serialized = serialize_device(device)
    if new_status != prev_status:
        await state_cache.update_and_publish(serialized, new_status.value, now)
    else:
        await state_cache.upsert_device(serialized)

    return device


@router.post("/{device_id}/ssh-check", response_model=SshCheckResult)
async def ssh_check_device(
    device_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(SSH)),
) -> SshCheckResult:
    """Collect SSH facts (hostname/uptime/interfaces) from a device right now and
    persist them. Requires the `ssh` permission + ssh_enabled/credentials."""
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if not device.ssh_enabled:
        raise HTTPException(status_code=400, detail="SSH is not enabled for this device")

    add_audit(
        db, current_user, "device.ssh_check",
        target_type="device", target_id=str(device_id),
    )
    await db.commit()

    result = await collect_device(device_id)
    if result is None:
        raise HTTPException(status_code=400, detail="SSH is not configured for this device")
    # collect_device persists the new ssh_* fields AND refreshes the Redis snapshot.
    return SshCheckResult(**result)


class MuteRequest(BaseModel):
    muted: bool


class MaintenanceRequest(BaseModel):
    # Minutes from now; null/0 clears maintenance.
    minutes: int | None = None


async def _get_or_404(db: AsyncSession, device_id: uuid.UUID) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.post("/{device_id}/ack", response_model=DeviceRead)
async def ack_device(
    device_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(ACK)),
) -> Device:
    """Acknowledge the device's current alarm (cleared automatically on recovery)."""
    device = await _get_or_404(db, device_id)
    device.alarm_acked_at = datetime.now(timezone.utc)
    add_audit(db, current_user, "device.ack", target_type="device", target_id=str(device_id))
    await db.commit()
    await db.refresh(device)
    await state_cache.upsert_device(serialize_device(device))
    return device


@router.post("/{device_id}/mute", response_model=DeviceRead)
async def mute_device(
    device_id: uuid.UUID,
    body: MuteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MUTE)),
) -> Device:
    """Mute/unmute alert notifications for a device (still monitored)."""
    device = await _get_or_404(db, device_id)
    device.is_muted = body.muted
    add_audit(
        db, current_user, "device.mute", target_type="device", target_id=str(device_id),
        detail="muted" if body.muted else "unmuted",
    )
    await db.commit()
    await db.refresh(device)
    await state_cache.upsert_device(serialize_device(device))
    return device


@router.post("/{device_id}/maintenance", response_model=DeviceRead)
async def maintenance_device(
    device_id: uuid.UUID,
    body: MaintenanceRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MUTE)),
) -> Device:
    """Put a device under maintenance for N minutes (no alarms), or clear it."""
    device = await _get_or_404(db, device_id)
    if body.minutes and body.minutes > 0:
        device.maintenance_until = datetime.now(timezone.utc) + timedelta(minutes=body.minutes)
        detail = f"{body.minutes}m"
    else:
        device.maintenance_until = None
        detail = "cleared"
    add_audit(
        db, current_user, "device.maintenance", target_type="device",
        target_id=str(device_id), detail=detail,
    )
    await db.commit()
    await db.refresh(device)
    await state_cache.upsert_device(serialize_device(device))
    return device


class HistoryPoint(BaseModel):
    ts: datetime
    avg_rtt_ms: float | None
    uptime_pct: float
    samples: int


# range → (window interval, bucket interval) for the time-series query.
_HISTORY_RANGES = {
    "1h": ("1 hour", "1 minute"),
    "24h": ("24 hours", "5 minutes"),
    "7d": ("7 days", "1 hour"),
    "30d": ("30 days", "6 hours"),
}


@router.get("/{device_id}/history", response_model=list[HistoryPoint])
async def device_history(
    device_id: uuid.UUID,
    range: str = Query("24h"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[HistoryPoint]:
    """Time-bucketed latency + uptime for a device (TimescaleDB). Powers the
    latency trend chart in the drawer."""
    window, bucket = _HISTORY_RANGES.get(range, _HISTORY_RANGES["24h"])
    # bucket/window come from the server-controlled whitelist above (no user
    # input), so they're inlined as literals — binding them as params makes
    # asyncpg mis-infer their type as `interval` and reject the string.
    stmt = text(
        f"""
        SELECT time_bucket(INTERVAL '{bucket}', ts) AS bucket,
               avg(rtt_ms) FILTER (WHERE success)   AS avg_rtt,
               count(*)                             AS total,
               count(*) FILTER (WHERE success)      AS up
        FROM ping_history
        WHERE device_id = :did AND ts >= now() - INTERVAL '{window}'
        GROUP BY bucket
        ORDER BY bucket
        """
    )
    try:
        rows = (await db.execute(stmt, {"did": device_id})).all()
    except Exception as exc:  # noqa: BLE001 — e.g. time_bucket missing on vanilla PG
        logger.warning("history query failed for %s: %s", device_id, exc)
        return []

    points: list[HistoryPoint] = []
    for bucket_ts, avg_rtt, total, up in rows:
        total = int(total or 0)
        up = int(up or 0)
        points.append(
            HistoryPoint(
                ts=bucket_ts,
                avg_rtt_ms=round(float(avg_rtt), 2) if avg_rtt is not None else None,
                uptime_pct=round(up / total * 100, 1) if total else 0.0,
                samples=total,
            )
        )
    return points


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    device_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> None:
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    add_audit(
        db, current_user, "device.delete",
        target_type="device", target_id=str(device_id),
        detail=f"{device.vendor_name} ({device.ip_address})",
    )
    await db.delete(device)
    await db.commit()
    await state_cache.remove_device(device_id)
