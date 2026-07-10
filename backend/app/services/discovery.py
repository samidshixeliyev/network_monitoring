"""Auto-discovery — periodic ICMP sweep of configured subnets.

Runs in the collector process. Every DISCOVERY_INTERVAL_SECONDS it pings every
host in DISCOVERY_SUBNETS (comma-separated CIDRs, network/broadcast excluded)
reusing the same probe method as the ping scheduler. Responders that are
neither monitored Devices nor already in the pending list are recorded in
discovered_devices with a best-effort reverse-DNS name; an admin then approves
(→ real Device) or ignores them from the UI.

Deliberately conservative: subnets larger than DISCOVERY_MAX_HOSTS_PER_SUBNET
are skipped with a log line, and the sweep shares a small semaphore so it can't
starve the real monitoring probes.
"""
import asyncio
import ipaddress
import logging
import socket
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, DiscoveredDevice
from app.services.ping_scheduler import _ping_host

logger = logging.getLogger(__name__)

# Smaller than the monitoring semaphore on purpose — discovery is background work.
_sem = asyncio.Semaphore(32)


def _subnets() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    nets = []
    for part in settings.DISCOVERY_SUBNETS.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            logger.error("discovery: invalid CIDR %r — skipped", part)
    return nets


async def _reverse_dns(ip: str) -> str | None:
    try:
        name = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(None, socket.gethostbyaddr, ip),
            timeout=2.0,
        )
        return name[0][:255]
    except Exception:  # noqa: BLE001 — no PTR record is the common case
        return None


async def _probe(ip: str) -> tuple[str, float | None] | None:
    async with _sem:
        try:
            alive, rtt, _sent, _recv = await _ping_host(ip)
        except Exception:  # noqa: BLE001
            return None
    return (ip, rtt) if alive else None


async def run_sweep() -> dict:
    """One full sweep. Returns counters (also used by the on-demand endpoint).

    The (slow, minutes-long) network probing runs WITHOUT a DB session; a
    short-lived session at the end records the results — a connection held
    across the whole sweep is easy prey for restarts/idle timeouts."""
    nets = _subnets()
    if not nets:
        return {"swept": 0, "alive": 0, "new": 0}

    async with AsyncSessionLocal() as session:
        known_ips = {str(ip) for ip in await session.scalars(select(Device.ip_address))}

    swept = 0
    hits: list[tuple[str, float | None]] = []
    for net in nets:
        hosts = list(net.hosts())
        if len(hosts) > settings.DISCOVERY_MAX_HOSTS_PER_SUBNET:
            logger.warning(
                "discovery: %s has %d hosts (cap %d) — skipped; split it into smaller CIDRs",
                net, len(hosts), settings.DISCOVERY_MAX_HOSTS_PER_SUBNET,
            )
            continue
        targets = [str(h) for h in hosts if str(h) not in known_ips]
        swept += len(targets)
        results = await asyncio.gather(*(_probe(ip) for ip in targets))
        hits.extend(hit for hit in results if hit is not None)

    names = await asyncio.gather(*(_reverse_dns(ip) for ip, _ in hits))

    new_count = 0
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        pending = {
            str(row.ip_address): row
            for row in await session.scalars(select(DiscoveredDevice))
        }
        for (ip, rtt), hostname in zip(hits, names):
            row = pending.get(ip)
            if row is not None:
                row.last_seen = now
                row.rtt_ms = rtt
            else:
                new_count += 1
                session.add(
                    DiscoveredDevice(
                        ip_address=ip, rtt_ms=rtt, hostname=hostname,
                        first_seen=now, last_seen=now,
                    )
                )
        await session.commit()

    logger.info("discovery sweep: %d probed, %d alive, %d new pending", swept, len(hits), new_count)
    return {"swept": swept, "alive": len(hits), "new": new_count}


async def discovery_loop() -> None:
    if not settings.DISCOVERY_ENABLED:
        logger.info("discovery disabled (DISCOVERY_ENABLED=false)")
        return
    if not _subnets():
        logger.warning("DISCOVERY_ENABLED=true but DISCOVERY_SUBNETS is empty/invalid — idle")
        return

    logger.info(
        "discovery started — subnets=%s, every %ds",
        settings.DISCOVERY_SUBNETS, settings.DISCOVERY_INTERVAL_SECONDS,
    )
    while True:
        try:
            await run_sweep()
        except Exception as exc:  # noqa: BLE001
            logger.error("discovery sweep error: %s", exc, exc_info=True)
        await asyncio.sleep(settings.DISCOVERY_INTERVAL_SECONDS)
