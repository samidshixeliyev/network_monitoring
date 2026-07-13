"""SNMP trap receiver — SNMPv1 / SNMPv2c traps over UDP, into TimescaleDB.

Runs in the collector process (same shape as the syslog receiver). Datagrams are
BER-decoded with pysnmp's low-level message API (no MIB files — numeric OIDs, so
it stays offline), matched to a Device by source IP, buffered, and flushed to the
snmp_traps hypertable in batches.

Well-known traps (linkDown / linkUp / coldStart / warmStart / authenticationFailure
/ egpNeighborLoss) get a friendly name and a severity on the syslog 0..7 scale;
enterprise-specific traps are stored verbatim. Traps at or below
SNMP_TRAP_ALERT severity (warning) escalate through the alert channels,
rate-limited per source host so a flapping link can't flood the inbox.

Devices are pointed here with e.g. `snmp-server host <monitor-ip> traps public`
(Cisco) or `trap2sink <monitor-ip> public` (net-snmp). Port 162/udp is mapped to
the unprivileged SNMP_TRAP_PORT in docker-compose so the container stays non-root.
"""
import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone

from pyasn1.codec.ber import decoder
from pysnmp.proto import api
from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, SnmpTrap
from app.services import notify

logger = logging.getLogger(__name__)

_FLUSH_INTERVAL_SECONDS = 2.0
_FLUSH_MAX_ROWS = 200
_BUFFER_HARD_CAP = 10_000
_DEVICE_MAP_TTL_SECONDS = 60.0

# snmpTrapOID.0 (v2c) — its value is the trap identity OID.
_SNMP_TRAP_OID = "1.3.6.1.6.3.1.1.4.1.0"
# ifIndex column (varbind that carries the affected port on link traps).
_IF_INDEX_PREFIX = "1.3.6.1.2.1.2.2.1.1."

# Well-known trap OID → (friendly name, severity on the 0=emerg..7=debug scale).
_TRAP_NAMES: dict[str, tuple[str, int]] = {
    "1.3.6.1.6.3.1.1.5.1": ("coldStart", 4),               # warning
    "1.3.6.1.6.3.1.1.5.2": ("warmStart", 5),               # notice
    "1.3.6.1.6.3.1.1.5.3": ("linkDown", 2),                # crit
    "1.3.6.1.6.3.1.1.5.4": ("linkUp", 6),                  # info
    "1.3.6.1.6.3.1.1.5.5": ("authenticationFailure", 4),   # warning
    "1.3.6.1.6.3.1.1.5.6": ("egpNeighborLoss", 4),         # warning
}


def parse_trap(data: bytes) -> dict | None:
    """BER-decode one datagram. Returns a parsed trap dict, or None if the
    payload isn't a decodable SNMPv1/v2c *trap* (informs / get-requests ignored)."""
    try:
        msg_ver = int(api.decodeMessageVersion(data))
    except Exception:  # noqa: BLE001 — junk packet
        return None
    if msg_ver not in api.PROTOCOL_MODULES:
        return None
    p_mod = api.PROTOCOL_MODULES[msg_ver]
    try:
        req_msg, _ = decoder.decode(data, asn1Spec=p_mod.Message())
    except Exception:  # noqa: BLE001
        return None
    req_pdu = p_mod.apiMessage.get_pdu(req_msg)

    if msg_ver == api.SNMP_VERSION_1 and req_pdu.isSameTypeWith(p_mod.TrapPDU()):
        version = "1"
        var_binds = p_mod.apiTrapPDU.get_varbinds(req_pdu)
        generic = int(p_mod.apiTrapPDU.get_generic_trap(req_pdu))
        if generic == 6:  # enterpriseSpecific → RFC2576 OID conversion
            enterprise = str(p_mod.apiTrapPDU.get_enterprise(req_pdu))
            specific = int(p_mod.apiTrapPDU.get_specific_trap(req_pdu))
            trap_oid = f"{enterprise}.0.{specific}"
            name, sev = "enterpriseSpecific", 4
        else:
            trap_oid = f"1.3.6.1.6.3.1.1.5.{generic + 1}"
            name, sev = _TRAP_NAMES.get(trap_oid, ("trap", 5))
    elif msg_ver == api.SNMP_VERSION_2C and req_pdu.isSameTypeWith(p_mod.SNMPv2TrapPDU()):
        version = "2c"
        var_binds = p_mod.apiPDU.get_varbinds(req_pdu)
        trap_oid = None
        for oid, val in var_binds:
            if str(oid) == _SNMP_TRAP_OID:
                trap_oid = str(val)
                break
        name, sev = _TRAP_NAMES.get(trap_oid or "", ("trap", 5))
    else:
        return None

    if_index: int | None = None
    vb_list: list[list[str]] = []
    for oid, val in var_binds:
        o = str(oid)
        vb_list.append([o, val.prettyPrint() if hasattr(val, "prettyPrint") else str(val)])
        if if_index is None and o.startswith(_IF_INDEX_PREFIX):
            try:
                if_index = int(val)
            except (TypeError, ValueError):
                pass

    message = name
    if if_index is not None:
        message += f" (ifIndex {if_index})"
    if trap_oid and name in ("trap", "enterpriseSpecific"):
        message += f" [{trap_oid}]"

    return {
        "version": version,
        "trap_oid": trap_oid,
        "trap_name": name,
        "severity": sev,
        "if_index": if_index,
        "message": message,
        "varbinds": vb_list,
    }


class _TrapProtocol(asyncio.DatagramProtocol):
    def __init__(self, buffer: list, dropped: list) -> None:
        self._buffer = buffer
        self._dropped = dropped

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        if len(self._buffer) >= _BUFFER_HARD_CAP:
            self._dropped[0] += 1
            return
        parsed = parse_trap(data)
        if parsed is None:
            return
        parsed["ts"] = datetime.now(timezone.utc)
        parsed["host"] = addr[0]
        self._buffer.append(parsed)


async def _device_map() -> dict[str, uuid.UUID]:
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(select(Device.ip_address, Device.id))).all()
    return {str(ip): did for ip, did in rows}


# Per-host "last alerted" for escalation rate-limiting.
_alerted_at: dict[str, float] = {}
# Hard cap in case a flood of unique source IPs alerts within one cooldown window.
_ALERTED_MAX = 4096


def _prune_alerted(now: float, cooldown: float) -> None:
    """Drop hosts past their cooldown (they no longer rate-limit anything), so a
    churning set of source IPs — DHCP pools, scanners hitting the open UDP port —
    can't grow _alerted_at without bound and OOM the long-running collector."""
    for host in [h for h, t in _alerted_at.items() if now - t >= cooldown]:
        del _alerted_at[host]
    if len(_alerted_at) > _ALERTED_MAX:
        for host in sorted(_alerted_at, key=_alerted_at.__getitem__)[: len(_alerted_at) - _ALERTED_MAX]:
            del _alerted_at[host]


async def _maybe_alert(rows: list[dict]) -> None:
    if not (settings.SNMP_TRAP_ALERT and settings.ALERT_ENABLED):
        return
    max_sev = settings.SNMP_TRAP_ALERT_MAX_SEVERITY
    if max_sev < 0:
        return
    now = time.monotonic()
    cooldown = settings.SNMP_TRAP_ALERT_COOLDOWN_SECONDS
    _prune_alerted(now, cooldown)
    for row in rows:
        # Alert on warning-or-worse traps (linkDown / authFailure / coldStart …);
        # linkUp / warmStart (info/notice) are informational only. The threshold
        # is configurable so planned-reboot coldStarts needn't page anyone.
        if row["severity"] > max_sev:
            continue
        last = _alerted_at.get(row["host"])
        if last and now - last < cooldown:
            continue
        _alerted_at[row["host"]] = now
        results = await notify.send_alert(
            f"[SNMP TRAP] {row['trap_name']} — {row['host']}",
            f"Host: {row['host']}\nTrap: {row['trap_name']}\n"
            f"OID: {row['trap_oid'] or '-'}\n"
            f"{'ifIndex: ' + str(row['if_index']) + chr(10) if row['if_index'] is not None else ''}"
            f"Time: {row['ts'].isoformat()}\n",
            kind="snmp_trap", device_ip=row["host"],
        )
        logger.info("snmp trap alert for %s (%s): %s", row["host"], row["trap_name"], notify.summarize(results))


async def _flush(buffer: list[dict], ip_to_device: dict[str, uuid.UUID]) -> None:
    rows, buffer[:] = buffer[:_FLUSH_MAX_ROWS * 2], buffer[_FLUSH_MAX_ROWS * 2:]
    async with AsyncSessionLocal() as session:
        for row in rows:
            session.add(
                SnmpTrap(
                    ts=row["ts"],
                    host=row["host"],
                    device_id=ip_to_device.get(row["host"]),
                    version=row["version"],
                    trap_oid=(row["trap_oid"] or None) and row["trap_oid"][:255],
                    trap_name=row["trap_name"][:80],
                    severity=row["severity"],
                    if_index=row["if_index"],
                    message=row["message"][:8000],
                    varbinds=json.dumps(row["varbinds"], ensure_ascii=False)[:8000],
                )
            )
        await session.commit()
    await _maybe_alert(rows)


async def snmp_trap_loop() -> None:
    if not settings.SNMP_TRAP_ENABLED:
        logger.info("SNMP trap receiver disabled (SNMP_TRAP_ENABLED=false)")
        return

    buffer: list[dict] = []
    dropped = [0]
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: _TrapProtocol(buffer, dropped),
        local_addr=(settings.SNMP_TRAP_BIND, settings.SNMP_TRAP_PORT),
    )
    logger.info(
        "SNMP trap receiver listening on %s:%d/udp",
        settings.SNMP_TRAP_BIND, settings.SNMP_TRAP_PORT,
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
                    logger.warning("snmp trap buffer overflow — dropped %d traps", dropped[0])
                    dropped[0] = 0
            except Exception as exc:  # noqa: BLE001
                logger.error("snmp trap flush error: %s", exc, exc_info=True)
    finally:
        transport.close()
