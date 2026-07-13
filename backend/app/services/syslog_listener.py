"""Syslog receiver — RFC3164 / RFC5424 over UDP, straight into TimescaleDB.

Runs in the collector process. Datagrams are parsed leniently (real network
gear is sloppy about the RFCs), matched to a Device by source IP, buffered, and
flushed to the syslog_history hypertable in batches so a chatty switch can't
turn every log line into its own transaction.

Messages at or below SYSLOG_ALERT_MAX_SEVERITY (default: crit) also go through
the alert channels, rate-limited per source host so one crash-looping device
can't flood the inbox.

Devices are pointed here with e.g. `logging host <monitor-ip>` (Cisco) or
`set system syslog host <monitor-ip>` (Junos). Port 514 is mapped to the
unprivileged SYSLOG_PORT in docker-compose so the container stays non-root.
"""
import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, SyslogMessage
from app.services import notify

logger = logging.getLogger(__name__)

_FLUSH_INTERVAL_SECONDS = 2.0
_FLUSH_MAX_ROWS = 200
# Drop (with a counter) instead of growing without bound if the DB stalls.
_BUFFER_HARD_CAP = 10_000
# Refresh the ip → device_id map this often.
_DEVICE_MAP_TTL_SECONDS = 60.0

SEVERITY_NAMES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"]

# <PRI> then either RFC5424 ("1 2026-07-07T10:00:00Z host app ...") or RFC3164
# ("Jul  7 10:00:00 host tag: message").
_PRI_RE = re.compile(r"^<(\d{1,3})>")
_RFC5424_RE = re.compile(
    r"^1 (?P<ts>\S+) (?P<host>\S+) (?P<app>\S+) \S+ \S+ (?:\[.*?\]|-) ?(?P<msg>.*)$",
    re.DOTALL,
)
_RFC3164_RE = re.compile(
    r"^(?:[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} )?(?:(?P<host>[\w.:-]+) )?"
    r"(?P<tag>[\w./-]+(?:\[\d+\])?): ?(?P<msg>.*)$",
    re.DOTALL,
)


def parse_syslog(raw: str) -> tuple[int | None, int, str | None, str]:
    """→ (facility, severity, app_name, message). Unparseable input is kept
    verbatim as the message with severity=info so nothing is ever dropped."""
    facility: int | None = None
    severity = 6
    rest = raw.strip()
    m = _PRI_RE.match(rest)
    if m:
        pri = int(m.group(1))
        if pri <= 191:
            facility, severity = divmod(pri, 8)
        rest = rest[m.end():]

    m = _RFC5424_RE.match(rest)
    if m:
        app = m.group("app")
        return facility, severity, None if app == "-" else app[:100], m.group("msg").strip()

    m = _RFC3164_RE.match(rest)
    if m and m.group("tag"):
        return facility, severity, m.group("tag")[:100], m.group("msg").strip()

    return facility, severity, None, rest


class _SyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, buffer: list, dropped: list) -> None:
        self._buffer = buffer
        self._dropped = dropped

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        if len(self._buffer) >= _BUFFER_HARD_CAP:
            self._dropped[0] += 1
            return
        facility, severity, app_name, message = parse_syslog(
            data.decode("utf-8", errors="replace")
        )
        if not message:
            return
        self._buffer.append(
            {
                "ts": datetime.now(timezone.utc),
                "host": addr[0],
                "facility": facility,
                "severity": severity,
                "app_name": app_name,
                "message": message[:8000],
            }
        )


async def _device_map() -> dict[str, uuid.UUID]:
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(select(Device.ip_address, Device.id))).all()
    return {str(ip): did for ip, did in rows}


# Per-host "last alerted" for severity escalation rate-limiting.
_alerted_at: dict[str, float] = {}
# Hard cap in case a flood of unique source IPs alerts within one cooldown window.
_ALERTED_MAX = 4096


def _prune_alerted(now: float, cooldown: float) -> None:
    """Drop hosts past their cooldown so a churning set of source IPs can't grow
    _alerted_at without bound and OOM the long-running collector."""
    for host in [h for h, t in _alerted_at.items() if now - t >= cooldown]:
        del _alerted_at[host]
    if len(_alerted_at) > _ALERTED_MAX:
        for host in sorted(_alerted_at, key=_alerted_at.__getitem__)[: len(_alerted_at) - _ALERTED_MAX]:
            del _alerted_at[host]


async def _maybe_alert(rows: list[dict], ip_to_device: dict[str, uuid.UUID]) -> None:
    max_sev = settings.SYSLOG_ALERT_MAX_SEVERITY
    if max_sev < 0:
        return
    now = time.monotonic()
    cooldown = settings.SYSLOG_ALERT_COOLDOWN_SECONDS
    _prune_alerted(now, cooldown)
    for row in rows:
        if row["severity"] > max_sev:
            continue
        last = _alerted_at.get(row["host"])
        if last and now - last < cooldown:
            continue
        _alerted_at[row["host"]] = now
        sev_name = SEVERITY_NAMES[row["severity"]]
        results = await notify.send_alert(
            f"[SYSLOG {sev_name.upper()}] {row['host']}",
            f"Host: {row['host']}\nSeverity: {sev_name}\n"
            f"App: {row['app_name'] or '-'}\nMessage: {row['message'][:500]}\n"
            f"Time: {row['ts'].isoformat()}\n",
            kind="syslog", device_ip=row["host"],
        )
        logger.info("syslog alert for %s (%s): %s", row["host"], sev_name, notify.summarize(results))


async def _flush(buffer: list[dict], ip_to_device: dict[str, uuid.UUID]) -> None:
    rows, buffer[:] = buffer[:_FLUSH_MAX_ROWS * 2], buffer[_FLUSH_MAX_ROWS * 2:]
    async with AsyncSessionLocal() as session:
        for row in rows:
            session.add(SyslogMessage(device_id=ip_to_device.get(row["host"]), **row))
        await session.commit()
    await _maybe_alert(rows, ip_to_device)


async def syslog_loop() -> None:
    if not settings.SYSLOG_ENABLED:
        logger.info("syslog receiver disabled (SYSLOG_ENABLED=false)")
        return

    buffer: list[dict] = []
    dropped = [0]
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: _SyslogProtocol(buffer, dropped),
        local_addr=(settings.SYSLOG_BIND, settings.SYSLOG_PORT),
    )
    logger.info(
        "syslog receiver listening on %s:%d/udp (alert at severity ≤ %d)",
        settings.SYSLOG_BIND, settings.SYSLOG_PORT, settings.SYSLOG_ALERT_MAX_SEVERITY,
    )

    ip_to_device: dict[str, uuid.UUID] = {}
    map_refreshed = 0.0
    try:
        while True:
            await asyncio.sleep(_FLUSH_INTERVAL_SECONDS)
            if not buffer:
                continue
            try:
                now = time.monotonic()
                if now - map_refreshed > _DEVICE_MAP_TTL_SECONDS:
                    ip_to_device = await _device_map()
                    map_refreshed = now
                while buffer:
                    await _flush(buffer, ip_to_device)
                if dropped[0]:
                    logger.warning("syslog buffer overflow — dropped %d messages", dropped[0])
                    dropped[0] = 0
            except Exception as exc:  # noqa: BLE001
                logger.error("syslog flush error: %s", exc, exc_info=True)
    finally:
        transport.close()
