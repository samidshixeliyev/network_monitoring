import asyncio
import logging
import platform
import re
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, EventLog, PingHistory
from app.models.device import DeviceStatus
from app.models.event_log import EventType
from app.schemas.device import serialize_device
from app.services import state_cache
from app.services.checks import http_check, tcp_check

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# Per-device next-check time (monotonic seconds). This is what spreads the checks
# out over the interval (staggered scheduling) instead of pinging everything at
# the same instant.
_schedule: dict[uuid.UUID, float] = {}

# Per-device monotonic deadline until which a device is "volatile" → probed at
# the fast cadence (set on any status change; see _check_one).
_volatile_until: dict[uuid.UUID, float] = {}

# Bound how many devices are probed concurrently at any moment.
_sem = asyncio.Semaphore(64)


def _next_interval(did: uuid.UUID, now: float) -> int:
    """Adaptive cadence: recently-changed / unsettled devices are probed fast,
    healthy-and-stable ones slow."""
    if now < _volatile_until.get(did, 0.0):
        return settings.PING_FAST_INTERVAL_SECONDS
    return settings.PING_INTERVAL_SECONDS


_RTT_RE = re.compile(r"=\s*[\d.]+/([\d.]+)/")  # Linux: rtt min/avg/max/mdev = ...


# ── ICMP probing ────────────────────────────────────────────────────────────
_LINUX_RECV_RE = re.compile(r"(\d+)\s+(?:packets\s+)?received")


async def _system_ping(ip: str) -> tuple[bool, float | None, int, int]:
    """Send PING_COUNT echo requests via the OS `ping` command (no admin needed
    on Windows). Returns (alive, avg_rtt_ms, sent, received). Alive if AT LEAST
    ONE reply — received < sent shows up as partial packet loss."""
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
        return False, None, count, 0

    out = stdout.decode(errors="replace")
    rtt: float | None = None
    if _IS_WINDOWS:
        # Count real echo replies; Windows counts "Destination host unreachable"
        # lines as Received and exits 0, so "Received = N" can't be trusted.
        received = out.upper().count("TTL=")
        if proc.returncode != 0 or received == 0:
            return False, None, count, 0
        m = re.search(r"Average\s*=\s*(\d+)ms", out)
        rtt = float(m.group(1)) if m else None
    else:
        m = _LINUX_RECV_RE.search(out)
        received = int(m.group(1)) if m else (count if proc.returncode == 0 else 0)
        if proc.returncode != 0 and received == 0:
            return False, None, count, 0
        m = _RTT_RE.search(out)
        rtt = float(m.group(1)) if m else None
    return received > 0, rtt, count, min(received, count)


async def _ping_host(ip: str) -> tuple[bool, float | None, int, int]:
    """Returns (alive, avg_rtt_ms, packets_sent, packets_received)."""
    if settings.PING_METHOD == "icmplib":
        from icmplib import async_ping

        host = await async_ping(
            ip, count=settings.PING_COUNT, timeout=settings.PING_TIMEOUT_SECONDS, privileged=True
        )
        rtt = host.avg_rtt if host.is_alive and host.avg_rtt else None
        return host.is_alive, rtt, host.packets_sent, host.packets_received
    return await _system_ping(ip)


# ── State machine: online → unknown → offline ───────────────────────────────
async def _check_one(device_id: uuid.UUID) -> None:
    # ── Phase 1: read config, then RELEASE the pool connection ────────────────
    # Holding a session across the multi-second ping (+ TCP/HTTP checks) pins one
    # pool connection per in-flight probe; with 64 concurrent checks that drains
    # the pool and serializes everything on pool-timeouts. So we read what we
    # need, drop the connection, probe, then reopen a short session to write.
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
        if device is None or not device.is_enabled:
            return
        ip = str(device.ip_address)
        check_tcp_port = device.check_tcp_port
        check_http_url = device.check_http_url
        check_http_expect = device.check_http_expect

    # ── Phase 2: probe with NO DB connection held ─────────────────────────────
    alive, rtt_ms, sent, received = await _ping_host(ip)

    has_service_check = bool(check_tcp_port or check_http_url)
    service_ok: bool | None = None
    service_detail: str | None = None
    if has_service_check:
        # Multi-condition: TCP/HTTP service check (catches "pings but service dead").
        ok = True
        details: list[str] = []
        if check_tcp_port:
            o, d = await tcp_check(ip, check_tcp_port)
            ok = ok and o
            details.append(d)
        if check_http_url:
            o, d = await http_check(check_http_url, check_http_expect or 200)
            ok = ok and o
            details.append(d)
        service_ok = ok
        service_detail = "; ".join(details)[:255]

    # ── Phase 3: persist on a fresh short-lived session ───────────────────────
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
        if device is None or not device.is_enabled:
            return

        prev_status = device.current_status
        prev_service_ok = device.service_ok
        now = datetime.now(timezone.utc)
        device.last_checked_at = now

        # Time-series sample for latency/uptime/loss charts (TimescaleDB hypertable).
        session.add(
            PingHistory(
                ts=now, device_id=device.id, success=alive, rtt_ms=rtt_ms,
                sent=sent, received=received,
            )
        )

        if alive:
            device.consecutive_failures = 0
            new_status = DeviceStatus.online
        else:
            device.consecutive_failures += 1
            if device.consecutive_failures >= settings.FLAP_THRESHOLD:
                new_status = DeviceStatus.offline      # 2nd (Nth) miss → red
            else:
                new_status = DeviceStatus.unknown      # 1st miss → yellow

        if has_service_check:
            device.service_ok = service_ok
            device.service_detail = service_detail
        else:
            device.service_ok = None
            device.service_detail = None

        # Clear a stale acknowledgement once the device is back online.
        if new_status == DeviceStatus.online and device.alarm_acked_at is not None:
            device.alarm_acked_at = None

        # Adaptive cadence: keep probing fast while the device is unsettled
        # (not online) or just changed state, so outages/recoveries are caught
        # quickly; let it relax to the slow cadence once it's stably online.
        mono = time.monotonic()
        if new_status != DeviceStatus.online or new_status != prev_status:
            _volatile_until[device_id] = mono + settings.PING_VOLATILE_WINDOW_SECONDS

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
        # No status change, but if the service-check result flipped, refresh the
        # cached snapshot so the dashboard reflects "service degraded" on refetch.
        if device.service_ok != prev_service_ok:
            await session.refresh(device)
            await state_cache.upsert_device(serialize_device(device))


# ── Staggered + adaptive scheduler ──────────────────────────────────────────
async def _refresh_schedule(now: float) -> None:
    """Add newly-enabled devices to the schedule (spread across the slow interval
    so they don't all fire together) and drop removed/disabled ones."""
    async with AsyncSessionLocal() as session:
        ids = list(
            await session.scalars(select(Device.id).where(Device.is_enabled.is_(True)))
        )
    id_set = set(ids)

    for did in list(_schedule):
        if did not in id_set:
            del _schedule[did]
            _volatile_until.pop(did, None)

    interval = settings.PING_INTERVAL_SECONDS
    for did in ids:
        if did not in _schedule:
            # Stable per-device offset in [0, interval): spreads first checks out.
            offset = (hash(str(did)) % (interval * 1000)) / 1000.0
            _schedule[did] = now + offset


async def _run_due(now: float) -> None:
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
    # Reschedule each checked device by ITS OWN adaptive interval (fast if it just
    # changed / isn't online, slow if stably healthy). Staggering is preserved.
    after = time.monotonic()
    for did in due:
        _schedule[did] = after + _next_interval(did, after)


async def ping_loop() -> None:
    if settings.SIMULATION_MODE:
        logger.info("ping loop in SIMULATION_MODE — probing disabled, manual status only")
        while True:
            await asyncio.sleep(3600)

    logger.info(
        "ping loop started — adaptive (method=%s, healthy=%ds, fast=%ds, count=%d, flap=%d)",
        settings.PING_METHOD,
        settings.PING_INTERVAL_SECONDS,
        settings.PING_FAST_INTERVAL_SECONDS,
        settings.PING_COUNT,
        settings.FLAP_THRESHOLD,
    )
    while True:
        try:
            now = time.monotonic()
            await _refresh_schedule(now)
            await _run_due(now)
            # Heartbeat so the UI can tell "all healthy" from "monitor stuck".
            await state_cache.set_heartbeat(datetime.now(timezone.utc).isoformat())
        except Exception as exc:
            logger.error("scheduler tick error: %s", exc, exc_info=True)
        # Tick frequently so the per-device stagger has ~1s resolution.
        await asyncio.sleep(1.0)
