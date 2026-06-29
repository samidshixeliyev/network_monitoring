import asyncio
import logging
import platform
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, EventLog
from app.models.device import DeviceStatus
from app.models.event_log import EventType
from app.schemas.device import serialize_device
from app.services import state_cache

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# Per-device next-check time (monotonic seconds). This is what spreads the checks
# out over the interval (staggered scheduling) instead of pinging everything at
# the same instant.
_schedule: dict[uuid.UUID, float] = {}

# Bound how many devices are probed concurrently at any moment.
_sem = asyncio.Semaphore(64)


# ── ICMP probing ────────────────────────────────────────────────────────────
async def _system_ping(ip: str) -> bool:
    """Send PING_COUNT echo requests via the OS `ping` command (no admin needed
    on Windows). Alive if AT LEAST ONE reply comes back."""
    count = settings.PING_COUNT
    timeout = settings.PING_TIMEOUT_SECONDS
    if _IS_WINDOWS:
        cmd = ["ping", "-n", str(count), "-w", str(timeout * 1000), ip]
    else:
        cmd = ["ping", "-c", str(count), "-W", str(timeout), ip]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        stdout, _ = await proc.communicate()
    except Exception as exc:  # pragma: no cover - environment dependent
        logger.debug("ping spawn failed for %s: %s", ip, exc)
        return False

    if proc.returncode != 0:
        return False
    # Windows `ping` can exit 0 on "Destination host unreachable" without a real
    # echo reply — require a TTL to confirm at least one packet actually returned.
    if _IS_WINDOWS:
        return b"TTL=" in stdout.upper()
    return True


async def _ping_host(ip: str) -> bool:
    if settings.PING_METHOD == "icmplib":
        from icmplib import async_ping

        host = await async_ping(
            ip, count=settings.PING_COUNT, timeout=settings.PING_TIMEOUT_SECONDS, privileged=True
        )
        return host.is_alive
    return await _system_ping(ip)


# ── State machine: online → unknown → offline ───────────────────────────────
async def _check_one(device_id: uuid.UUID) -> None:
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
        if device is None or not device.is_enabled:
            return

        ip = str(device.ip_address)
        alive = await _ping_host(ip)

        prev_status = device.current_status
        now = datetime.now(timezone.utc)
        device.last_checked_at = now

        if alive:
            device.consecutive_failures = 0
            new_status = DeviceStatus.online
        else:
            device.consecutive_failures += 1
            if device.consecutive_failures >= settings.FLAP_THRESHOLD:
                new_status = DeviceStatus.offline      # 2nd (Nth) miss → red
            else:
                new_status = DeviceStatus.unknown      # 1st miss → yellow

        if new_status != prev_status:
            device.current_status = new_status
            # Only the hard online/offline edges are notable events; the
            # intermediate "unknown" is a warning state (no event row).
            if new_status == DeviceStatus.online:
                session.add(EventLog(device_id=device.id, event_type=EventType.came_online))
            elif new_status == DeviceStatus.offline:
                session.add(EventLog(device_id=device.id, event_type=EventType.went_offline))
            await session.commit()
            # refresh() reloads server-generated columns (updated_at) in-context;
            # serializing them lazily after commit would trigger sync IO → error.
            await session.refresh(device)
            serialized = serialize_device(device)
            # Refresh the Redis snapshot + publish the delta to all gateways.
            # Every change (incl. → unknown) is published so the map recolors live.
            await state_cache.update_and_publish(serialized, new_status.value, now)
            logger.info("device %s: %s → %s", ip, prev_status.value, new_status.value)
            return

        await session.commit()


# ── Staggered scheduler ─────────────────────────────────────────────────────
async def _refresh_schedule(now: float, interval: int) -> None:
    """Add newly-enabled devices to the schedule (spread across the interval so
    they don't all fire together) and drop removed/disabled ones."""
    async with AsyncSessionLocal() as session:
        ids = list(
            await session.scalars(select(Device.id).where(Device.is_enabled.is_(True)))
        )
    id_set = set(ids)

    for did in list(_schedule):
        if did not in id_set:
            del _schedule[did]

    for did in ids:
        if did not in _schedule:
            # Stable per-device offset in [0, interval): spreads first checks out.
            offset = (hash(str(did)) % (interval * 1000)) / 1000.0
            _schedule[did] = now + offset


async def _run_due(now: float, interval: int) -> None:
    due = [did for did, t in _schedule.items() if t <= now]
    if not due:
        return

    async def run(did: uuid.UUID) -> None:
        async with _sem:
            try:
                await _check_one(did)
            except Exception as exc:
                logger.error("check failed for %s: %s", did, exc)

    await asyncio.gather(*(run(d) for d in due))
    # Reschedule each checked device exactly one interval out — because they
    # came due at staggered times, they stay staggered.
    after = time.monotonic()
    for did in due:
        _schedule[did] = after + interval


async def ping_loop() -> None:
    if settings.SIMULATION_MODE:
        logger.info("ping loop in SIMULATION_MODE — probing disabled, manual status only")
        while True:
            await asyncio.sleep(3600)

    interval = settings.PING_INTERVAL_SECONDS
    logger.info(
        "ping loop started — staggered (method=%s, interval=%ds, count=%d, flap=%d)",
        settings.PING_METHOD,
        interval,
        settings.PING_COUNT,
        settings.FLAP_THRESHOLD,
    )
    while True:
        try:
            now = time.monotonic()
            await _refresh_schedule(now, interval)
            await _run_due(now, interval)
        except Exception as exc:
            logger.error("scheduler tick error: %s", exc, exc_info=True)
        # Tick frequently so the per-device stagger has ~1s resolution.
        await asyncio.sleep(1.0)
