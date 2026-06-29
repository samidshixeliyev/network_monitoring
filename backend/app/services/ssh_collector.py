"""
SSH telemetry collector.

On top of ICMP up/down, this logs into ssh_enabled devices and pulls a few
facts (hostname, uptime, interfaces, kernel). Runs both as a background poll
loop (started from the app lifespan when SSH_ENABLED) and on demand via the
POST /devices/{id}/ssh-check endpoint.

Uses asyncssh (pure-python, async) — host-key checking is disabled
(known_hosts=None) because the lab containers regenerate keys on rebuild.
"""
import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device
from app.schemas.device import serialize_device
from app.services import state_cache

logger = logging.getLogger(__name__)

# Bound concurrent SSH sessions.
_sem = asyncio.Semaphore(16)


def _format_uptime(proc_uptime: str) -> str | None:
    """Turn the first field of /proc/uptime (seconds) into '1d 2h 3m'."""
    try:
        secs = int(float(proc_uptime.split()[0]))
    except (ValueError, IndexError):
        return None
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    parts = []
    if d:
        parts.append(f"{d}d")
    if h or d:
        parts.append(f"{h}h")
    parts.append(f"{m}m")
    return " ".join(parts)


def _parse_interfaces(ip_output: str) -> list[dict[str, str]]:
    """Parse `ip -o -4 addr show` lines into {name, ipv4} dicts."""
    interfaces: list[dict[str, str]] = []
    for line in ip_output.splitlines():
        cols = line.split()
        # e.g. "2: eth0    inet 172.30.0.11/24 brd ... scope global eth0"
        if len(cols) >= 4 and cols[2] == "inet":
            interfaces.append({"name": cols[1], "ipv4": cols[3]})
    return interfaces


async def _run_collection(host: str, port: int, username: str, password: str) -> dict:
    """Open one SSH session and gather facts. Raises on connection/auth errors."""
    import asyncssh

    facts: dict = {}
    async with asyncssh.connect(
        host,
        port=port,
        username=username,
        password=password,
        known_hosts=None,
        connect_timeout=settings.SSH_CONNECT_TIMEOUT_SECONDS,
    ) as conn:
        async def sh(cmd: str) -> str:
            r = await conn.run(cmd, timeout=settings.SSH_CONNECT_TIMEOUT_SECONDS, check=False)
            return (r.stdout or "").strip()

        hostname = await sh("hostname")
        proc_uptime = await sh("cat /proc/uptime")
        ip_out = await sh("ip -o -4 addr show 2>/dev/null")
        kernel = await sh("uname -sr")

    facts["interfaces"] = _parse_interfaces(ip_out)
    facts["kernel"] = kernel or None
    return {
        "hostname": hostname or None,
        "uptime": _format_uptime(proc_uptime),
        "facts": facts,
    }


async def collect_device(device_id: uuid.UUID) -> dict | None:
    """Collect SSH facts for one device and persist them. Returns a summary
    dict, or None if the device is missing / SSH not configured."""
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
        if device is None or not device.ssh_enabled:
            return None
        if not device.ssh_username:
            device.ssh_status = "error"
            device.ssh_collected_at = datetime.now(timezone.utc)
            await session.commit()
            return {"status": "error", "detail": "no ssh_username set"}

        host = str(device.ip_address)
        port = device.ssh_port or 22
        username = device.ssh_username
        password = device.ssh_password or ""

        status = "ok"
        detail = None
        result: dict | None = None
        try:
            result = await _run_collection(host, port, username, password)
        except Exception as exc:  # noqa: BLE001 — classify by message/type
            import asyncssh

            if isinstance(exc, asyncssh.PermissionDenied):
                status = "auth_failed"
            elif isinstance(exc, (asyncssh.ConnectionLost, ConnectionError, OSError, asyncio.TimeoutError)):
                status = "unreachable"
            else:
                status = "error"
            detail = f"{type(exc).__name__}: {exc}"
            logger.info("ssh collect %s (%s) → %s", host, status, detail)

        now = datetime.now(timezone.utc)
        device.ssh_status = status
        device.ssh_collected_at = now
        if result is not None:
            device.ssh_hostname = result["hostname"]
            device.ssh_uptime = result["uptime"]
            device.ssh_facts = json.dumps(result["facts"], ensure_ascii=False)
        await session.commit()
        # refresh() reloads server-generated columns (updated_at) in-context so
        # serialization doesn't trigger sync lazy IO after commit.
        await session.refresh(device)
        # Keep the Redis snapshot's ssh_* fields in sync for the dashboard.
        await state_cache.upsert_device(serialize_device(device))

        return {"status": status, "detail": detail, **(result or {})}


# ── Background poll loop ──────────────────────────────────────────────────────
async def ssh_poll_loop() -> None:
    if not settings.SSH_ENABLED:
        logger.info("SSH collector disabled (SSH_ENABLED=false)")
        return

    interval = settings.SSH_POLL_INTERVAL_SECONDS
    logger.info("SSH collector started — interval=%ds", interval)
    while True:
        start = time.monotonic()
        try:
            async with AsyncSessionLocal() as session:
                ids = list(
                    await session.scalars(
                        select(Device.id).where(
                            Device.ssh_enabled.is_(True),
                            Device.is_enabled.is_(True),
                        )
                    )
                )

            async def run(did: uuid.UUID) -> None:
                async with _sem:
                    try:
                        await collect_device(did)
                    except Exception as exc:
                        logger.error("ssh collect failed for %s: %s", did, exc)

            if ids:
                await asyncio.gather(*(run(d) for d in ids))
        except Exception as exc:
            logger.error("ssh poll tick error: %s", exc, exc_info=True)

        elapsed = time.monotonic() - start
        await asyncio.sleep(max(1.0, interval - elapsed))
