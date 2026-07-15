"""
SNMP telemetry collector.

Polls snmp_enabled devices over SNMP v2c for system info (sysName/sysDescr/
uptime), CPU and memory utilisation (HOST-RESOURCES-MIB, works on net-snmp
Linux agents and most servers; vendor CPU OIDs differ — point of extension for
Cisco/Juniper), and per-interface traffic counters (IF-MIB, 64-bit HC counters
with 32-bit fallback). Interface rates (bps) are computed from counter deltas
between polls and the device-level sums are recorded into the snmp_history
hypertable for the charts.

Runs both as a background poll loop (collector process, SNMP_ENABLED) and on
demand via POST /devices/{id}/snmp-check. Pure-python pysnmp, no MIB files —
numeric OIDs only, so it works offline.
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
from app.models import Device, SnmpHistory
from app.schemas.device import serialize_device
from app.services import state_cache

logger = logging.getLogger(__name__)

# Bound concurrent SNMP sessions.
_sem = asyncio.Semaphore(32)

# ── OIDs (numeric — no MIB resolution needed) ────────────────────────────────
OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0"
OID_SYS_UPTIME = "1.3.6.1.2.1.1.3.0"  # TimeTicks (1/100 s)
OID_SYS_NAME = "1.3.6.1.2.1.1.5.0"
# IF-MIB
OID_IF_DESCR = "1.3.6.1.2.1.2.2.1.2"
OID_IF_SPEED = "1.3.6.1.2.1.2.2.1.5"          # bps (32-bit)
OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8"    # 1=up 2=down
OID_IF_IN_OCTETS = "1.3.6.1.2.1.2.2.1.10"     # 32-bit fallback
OID_IF_OUT_OCTETS = "1.3.6.1.2.1.2.2.1.16"
OID_IF_NAME = "1.3.6.1.2.1.31.1.1.1.1"        # ifXTable
OID_IF_HC_IN = "1.3.6.1.2.1.31.1.1.1.6"       # 64-bit
OID_IF_HC_OUT = "1.3.6.1.2.1.31.1.1.1.10"
OID_IF_HIGH_SPEED = "1.3.6.1.2.1.31.1.1.1.15"  # Mbps
# HOST-RESOURCES-MIB
OID_HR_CPU_LOAD = "1.3.6.1.2.1.25.3.3.1.2"     # per-core %, walk + average
OID_HR_STORAGE_DESCR = "1.3.6.1.2.1.25.2.3.1.3"
OID_HR_STORAGE_UNITS = "1.3.6.1.2.1.25.2.3.1.4"
OID_HR_STORAGE_SIZE = "1.3.6.1.2.1.25.2.3.1.5"
OID_HR_STORAGE_USED = "1.3.6.1.2.1.25.2.3.1.6"
# ── Vendor CPU/memory (tried in order when HOST-RESOURCES yields nothing) ────
# Cisco (CISCO-PROCESS-MIB / CISCO-MEMORY-POOL-MIB)
OID_CISCO_CPU_5MIN = "1.3.6.1.4.1.9.9.109.1.1.1.1.8"   # cpmCPUTotal5minRev, walk
OID_CISCO_MEM_USED = "1.3.6.1.4.1.9.9.48.1.1.1.5"      # ciscoMemoryPoolUsed
OID_CISCO_MEM_FREE = "1.3.6.1.4.1.9.9.48.1.1.1.6"      # ciscoMemoryPoolFree
# Juniper (JUNIPER-MIB jnxOperatingTable — RE/FPC rows)
OID_JUNIPER_CPU = "1.3.6.1.4.1.2636.3.1.13.1.8"        # jnxOperatingCPU, walk
OID_JUNIPER_MEM = "1.3.6.1.4.1.2636.3.1.13.1.11"       # jnxOperatingBuffer (%), walk
# Nokia SR OS (TIMETRA-SYSTEM-MIB)
OID_NOKIA_CPU = "1.3.6.1.4.1.6527.3.1.2.1.1.1.0"       # sgiCpuUsage (%)
OID_NOKIA_MEM_USED = "1.3.6.1.4.1.6527.3.1.2.1.1.9.0"   # sgiMemoryUsed (bytes)
OID_NOKIA_MEM_AVAIL = "1.3.6.1.4.1.6527.3.1.2.1.1.10.0"  # sgiMemoryAvailable

# ── Comprehensive inventory OIDs (on-demand full SNMP walk) ───────────────────
# System / identity
OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"
OID_SYS_CONTACT = "1.3.6.1.2.1.1.4.0"
OID_SYS_LOCATION = "1.3.6.1.2.1.1.6.0"
# ENTITY-MIB entPhysicalTable — model / serial / revisions (chassis row = class 3)
OID_ENT_DESCR = "1.3.6.1.2.1.47.1.1.1.1.2"
OID_ENT_CLASS = "1.3.6.1.2.1.47.1.1.1.1.5"
OID_ENT_NAME = "1.3.6.1.2.1.47.1.1.1.1.7"
OID_ENT_HW_REV = "1.3.6.1.2.1.47.1.1.1.1.8"
OID_ENT_FW_REV = "1.3.6.1.2.1.47.1.1.1.1.9"
OID_ENT_SW_REV = "1.3.6.1.2.1.47.1.1.1.1.10"
OID_ENT_SERIAL = "1.3.6.1.2.1.47.1.1.1.1.11"
OID_ENT_MODEL = "1.3.6.1.2.1.47.1.1.1.1.13"
# HOST-RESOURCES storage type (classify disk vs ram)
OID_HR_STORAGE_TYPE = "1.3.6.1.2.1.25.2.3.1.2"
OID_HR_TYPE_FIXED_DISK = "1.3.6.1.2.1.25.2.1.4"
OID_HR_TYPE_RAM = "1.3.6.1.2.1.25.2.1.2"
# IF-MIB extras (rich interface table)
OID_IF_TYPE = "1.3.6.1.2.1.2.2.1.3"
OID_IF_MTU = "1.3.6.1.2.1.2.2.1.4"
OID_IF_PHYS = "1.3.6.1.2.1.2.2.1.6"           # MAC
OID_IF_ADMIN_STATUS = "1.3.6.1.2.1.2.2.1.7"
OID_IF_IN_DISCARDS = "1.3.6.1.2.1.2.2.1.13"
OID_IF_IN_ERRORS = "1.3.6.1.2.1.2.2.1.14"
OID_IF_OUT_DISCARDS = "1.3.6.1.2.1.2.2.1.19"
OID_IF_OUT_ERRORS = "1.3.6.1.2.1.2.2.1.20"
OID_IF_ALIAS = "1.3.6.1.2.1.31.1.1.1.18"
# ENTITY-SENSOR-MIB (temperature / fan / voltage / power)
OID_SENSOR_TYPE = "1.3.6.1.2.1.99.1.1.1.1"
OID_SENSOR_SCALE = "1.3.6.1.2.1.99.1.1.1.2"
OID_SENSOR_PRECISION = "1.3.6.1.2.1.99.1.1.1.3"
OID_SENSOR_VALUE = "1.3.6.1.2.1.99.1.1.1.4"
OID_SENSOR_STATUS = "1.3.6.1.2.1.99.1.1.1.5"
OID_SENSOR_UNITS = "1.3.6.1.2.1.99.1.1.1.6"
# Cisco CISCO-ENVMON-MIB fallback (temperature / fan / power supply state)
OID_CENV_TEMP_DESCR = "1.3.6.1.4.1.9.9.13.1.3.1.2"
OID_CENV_TEMP_VALUE = "1.3.6.1.4.1.9.9.13.1.3.1.3"
OID_CENV_TEMP_STATE = "1.3.6.1.4.1.9.9.13.1.3.1.6"
OID_CENV_FAN_DESCR = "1.3.6.1.4.1.9.9.13.1.4.1.2"
OID_CENV_FAN_STATE = "1.3.6.1.4.1.9.9.13.1.4.1.3"
OID_CENV_SUPPLY_DESCR = "1.3.6.1.4.1.9.9.13.1.5.1.2"
OID_CENV_SUPPLY_STATE = "1.3.6.1.4.1.9.9.13.1.5.1.3"
# VLANs
OID_DOT1Q_VLAN_NAME = "1.3.6.1.2.1.17.7.1.4.3.1.1"        # dot1qVlanStaticName
OID_CISCO_VTP_VLAN_NAME = "1.3.6.1.4.1.9.9.46.1.3.1.1.4"  # vtpVlanName
# MAC / forwarding database
OID_DOT1Q_FDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2"         # index = vlan.mac(6)
OID_DOT1D_FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"             # index = mac(6)
OID_DOT1D_BASE_PORT_IF = "1.3.6.1.2.1.17.1.4.1.2"         # bridge port → ifIndex
# ARP / neighbour cache (ipNetToMediaTable — universally implemented)
OID_ARP_PHYS = "1.3.6.1.2.1.4.22.1.2"                    # index = ifIndex.a.b.c.d
# Routing (ipCidrRouteTable primary, ipRouteTable fallback)
OID_IPCIDR_ROUTE_IFINDEX = "1.3.6.1.2.1.4.24.4.1.5"       # index = dest.mask.tos.nexthop
OID_IPCIDR_ROUTE_TYPE = "1.3.6.1.2.1.4.24.4.1.6"
OID_IPCIDR_ROUTE_PROTO = "1.3.6.1.2.1.4.24.4.1.7"
OID_IPROUTE_IFINDEX = "1.3.6.1.2.1.4.21.1.2"             # index = dest ip
OID_IPROUTE_NEXTHOP = "1.3.6.1.2.1.4.21.1.7"
OID_IPROUTE_MASK = "1.3.6.1.2.1.4.21.1.11"
# UPS-MIB (RFC1628)
OID_UPS_BATTERY_STATUS = "1.3.6.1.2.1.33.1.2.1.0"
OID_UPS_SECONDS_ON_BATT = "1.3.6.1.2.1.33.1.2.2.0"
OID_UPS_MINUTES_REMAIN = "1.3.6.1.2.1.33.1.2.3.0"
OID_UPS_CHARGE_PCT = "1.3.6.1.2.1.33.1.2.4.0"
OID_UPS_OUT_LOAD = "1.3.6.1.2.1.33.1.4.4.1.5"            # walk (per output line)
OID_UPS_IN_VOLTAGE = "1.3.6.1.2.1.33.1.3.3.1.3"          # walk
OID_UPS_OUT_VOLTAGE = "1.3.6.1.2.1.33.1.4.4.1.2"         # walk
# QoS / VPN / Wireless — best-effort name walks (vendor-specific; often empty)
OID_CBQOS_POLICYMAP_NAME = "1.3.6.1.4.1.9.9.166.1.6.1.1.1"  # cbQosPolicyMapName
OID_CBQOS_CM_NAME = "1.3.6.1.4.1.9.9.166.1.7.1.1.1"         # cbQosCMName
OID_IPSEC_TUN_PEER = "1.3.6.1.4.1.9.9.171.1.3.2.1.4"        # cipSecTunRemoteAddr
OID_IPSEC_TUN_STATUS = "1.3.6.1.4.1.9.9.171.1.3.2.1.14"     # cipSecTunStatus
OID_CISCO_AP_NAME = "1.3.6.1.4.1.9.9.513.1.1.1.1.5"         # cLApName (Cisco unified AP)

# Enterprise number → vendor label (from sysObjectID 1.3.6.1.4.1.<n>...).
_ENTERPRISE_VENDORS = {
    9: "Cisco", 2636: "Juniper", 6527: "Nokia", 2011: "Huawei",
    8072: "Net-SNMP", 11: "HP", 14988: "MikroTik", 30065: "Arista",
    2352: "Redback", 25506: "H3C", 12356: "Fortinet", 1991: "Foundry",
}

# ENTITY-SENSOR EntitySensorDataType → coarse sensor category.
_SENSOR_KIND = {
    3: "power", 4: "power", 5: "power", 6: "power",  # voltsAC/voltsDC/amperes/watts
    8: "temperature", 10: "fan",                     # celsius / rpm
}
_SENSOR_UNIT = {3: "VAC", 4: "VDC", 5: "A", 6: "W", 7: "Hz", 8: "°C", 9: "%RH", 10: "RPM"}

# Last-seen interface counters per device, for rate computation between polls:
# {device_id: {"t": monotonic, "if": {ifindex: (in_octets, out_octets)}}}
# Both dicts are keyed by device_id, so bounded by the device count.
_last_counters: dict[uuid.UUID, dict] = {}
# Separate delta chain for the live traffic modal's peeks, so its ~1×/s polls
# never overwrite the background loop's last snapshot (which would corrupt the
# persisted in_bps/out_bps of the next scheduled poll).
_peek_counters: dict[uuid.UUID, dict] = {}


def _format_uptime(ticks: int) -> str:
    secs = ticks // 100
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


# SNMPv3 USM protocol names → pysnmp protocol OIDs (resolved lazily so the
# import cost is only paid when a v3 device exists).
def _v3_protocols(auth_name: str, priv_name: str):
    from pysnmp.hlapi.v3arch.asyncio import (
        usmAesCfb128Protocol,
        usmAesCfb256Protocol,
        usmDESPrivProtocol,
        usmHMAC192SHA256AuthProtocol,
        usmHMACMD5AuthProtocol,
        usmHMACSHAAuthProtocol,
        usmNoAuthProtocol,
        usmNoPrivProtocol,
    )

    auth = {
        "none": usmNoAuthProtocol,
        "md5": usmHMACMD5AuthProtocol,
        "sha": usmHMACSHAAuthProtocol,
        "sha256": usmHMAC192SHA256AuthProtocol,
    }[auth_name]
    priv = {
        "none": usmNoPrivProtocol,
        "des": usmDESPrivProtocol,
        "aes": usmAesCfb128Protocol,
        "aes256": usmAesCfb256Protocol,
    }[priv_name]
    return auth, priv


class _Snmp:
    """Thin wrapper around pysnmp asyncio for GET + WALK.

    v2c rides the lightweight v1arch dispatcher; v3 (USM auth/priv) needs the
    full v3arch SnmpEngine. Both expose the same get/walk/close interface, so
    the collection code above doesn't care which one it got."""

    def __init__(
        self,
        host: str,
        port: int,
        *,
        community: str | None = None,
        v3_user: str | None = None,
        v3_auth_proto: str = "sha",
        v3_auth_key: str | None = None,
        v3_priv_proto: str = "aes",
        v3_priv_key: str | None = None,
    ):
        self.host = host
        self.port = port
        self.v3 = v3_user is not None
        if self.v3:
            from pysnmp.hlapi.v3arch.asyncio import ContextData, SnmpEngine, UsmUserData

            auth_proto, priv_proto = _v3_protocols(v3_auth_proto, v3_priv_proto)
            kwargs: dict = {}
            # A requested auth/priv protocol with no matching key must FAIL loudly:
            # silently dropping to noAuthNoPriv would make an authPriv-only agent
            # reject us with a bare timeout, hiding the real cause (missing key).
            if v3_auth_proto != "none":
                if not v3_auth_key:
                    raise ValueError(
                        f"SNMPv3 user {v3_user!r} requests auth '{v3_auth_proto}' "
                        "but no auth key is configured"
                    )
                kwargs = {"authKey": v3_auth_key, "authProtocol": auth_proto}
                if v3_priv_proto != "none":
                    if not v3_priv_key:
                        raise ValueError(
                            f"SNMPv3 user {v3_user!r} requests priv '{v3_priv_proto}' "
                            "but no priv key is configured"
                        )
                    kwargs |= {"privKey": v3_priv_key, "privProtocol": priv_proto}
            self.engine = SnmpEngine()
            self.auth = UsmUserData(v3_user, **kwargs)
            self.context = ContextData()
        else:
            from pysnmp.hlapi.v1arch.asyncio import CommunityData, SnmpDispatcher

            self.dispatcher = SnmpDispatcher()
            self.auth = CommunityData(community, mpModel=1)  # v2c

    async def _target(self):
        if self.v3:
            from pysnmp.hlapi.v3arch.asyncio import UdpTransportTarget
        else:
            from pysnmp.hlapi.v1arch.asyncio import UdpTransportTarget

        return await UdpTransportTarget.create(
            (self.host, self.port),
            timeout=settings.SNMP_TIMEOUT_SECONDS,
            retries=settings.SNMP_RETRIES,
        )

    async def _cmd_args(self) -> tuple:
        if self.v3:
            return (self.engine, self.auth, await self._target(), self.context)
        return (self.dispatcher, self.auth, await self._target())

    def _hlapi(self):
        if self.v3:
            from pysnmp.hlapi.v3arch import asyncio as hlapi
        else:
            from pysnmp.hlapi.v1arch import asyncio as hlapi
        return hlapi

    async def get(self, *oids: str) -> dict[str, object]:
        """GET scalars. Returns {oid: value} (missing/noSuchObject omitted)."""
        hlapi = self._hlapi()
        err_ind, err_status, _err_idx, var_binds = await hlapi.get_cmd(
            *await self._cmd_args(),
            *[hlapi.ObjectType(hlapi.ObjectIdentity(o)) for o in oids],
        )
        if err_ind:
            raise TimeoutError(str(err_ind))
        if err_status:
            raise RuntimeError(err_status.prettyPrint())
        out: dict[str, object] = {}
        for name, value in var_binds:
            if value is None or value.__class__.__name__ in ("NoSuchObject", "NoSuchInstance"):
                continue
            out[str(name)] = value
        return out

    async def walk(self, base_oid: str) -> dict[int, object]:
        """WALK a column. Returns {last_index: value}."""
        hlapi = self._hlapi()
        out: dict[int, object] = {}
        async for err_ind, err_status, _err_idx, var_binds in hlapi.walk_cmd(
            *await self._cmd_args(),
            hlapi.ObjectType(hlapi.ObjectIdentity(base_oid)),
        ):
            if err_ind:
                raise TimeoutError(str(err_ind))
            if err_status:
                raise RuntimeError(err_status.prettyPrint())
            for name, value in var_binds:
                oid = str(name)
                if not oid.startswith(base_oid + "."):
                    return out
                out[int(oid.rsplit(".", 1)[1])] = value
        return out

    async def walk_full(self, base_oid: str, *, max_rows: int | None = None) -> dict[str, object]:
        """WALK a subtree keeping the FULL index suffix (the dotted remainder
        after base_oid). Multi-part table indexes — ARP (ifIndex.a.b.c.d),
        routing (dest.mask.tos.nexthop), FDB (vlan.mac), sensors — can't be
        keyed by a single trailing integer like walk() does. Optionally stops
        after max_rows to bound huge tables (routing/FDB)."""
        hlapi = self._hlapi()
        out: dict[str, object] = {}
        prefix = base_oid + "."
        async for err_ind, err_status, _err_idx, var_binds in hlapi.walk_cmd(
            *await self._cmd_args(),
            hlapi.ObjectType(hlapi.ObjectIdentity(base_oid)),
        ):
            if err_ind:
                raise TimeoutError(str(err_ind))
            if err_status:
                raise RuntimeError(err_status.prettyPrint())
            for name, value in var_binds:
                oid = str(name)
                if not oid.startswith(prefix):
                    return out
                out[oid[len(prefix):]] = value
            if max_rows is not None and len(out) >= max_rows:
                return out
        return out

    def close(self) -> None:
        if self.v3:
            close = getattr(self.engine, "close_dispatcher", None)
            if close is not None:
                close()
            elif self.engine.transport_dispatcher is not None:
                self.engine.transport_dispatcher.close_dispatcher()
        else:
            self.dispatcher.close()


def _mem_percent(descrs: dict, units: dict, sizes: dict, useds: dict) -> float | None:
    """Physical-memory utilisation from the hrStorage table."""
    for idx, descr in descrs.items():
        text = str(descr).lower()
        if "physical memory" in text or "real memory" in text or text == "memory":
            try:
                size = int(sizes[idx])
                used = int(useds[idx])
                _ = int(units[idx])  # units cancel out in the ratio
                if size > 0:
                    return round(used / size * 100, 1)
            except (KeyError, ValueError):
                return None
    return None


async def _vendor_cpu(snmp: "_Snmp") -> float | None:
    """CPU % via vendor MIBs: Cisco → Juniper → Nokia (first that answers)."""
    for oid in (OID_CISCO_CPU_5MIN, OID_JUNIPER_CPU):
        try:
            rows = await snmp.walk(oid)
            vals = [int(v) for v in rows.values() if int(v) > 0]
            if vals:
                return round(sum(vals) / len(vals), 1)
        except Exception:  # noqa: BLE001
            pass
    try:
        vals = await snmp.get(OID_NOKIA_CPU)
        if vals:
            return round(float(int(next(iter(vals.values())))), 1)
    except Exception:  # noqa: BLE001
        pass
    return None


async def _vendor_mem(snmp: "_Snmp") -> float | None:
    """Memory % via vendor MIBs: Cisco pools → Juniper buffer → Nokia."""
    try:
        used_rows = await snmp.walk(OID_CISCO_MEM_USED)
        free_rows = await snmp.walk(OID_CISCO_MEM_FREE)
        used = sum(int(v) for v in used_rows.values())
        free = sum(int(v) for v in free_rows.values())
        if used + free > 0:
            return round(used / (used + free) * 100, 1)
    except Exception:  # noqa: BLE001
        pass
    try:
        rows = await snmp.walk(OID_JUNIPER_MEM)
        vals = [int(v) for v in rows.values() if int(v) > 0]
        if vals:
            return round(sum(vals) / len(vals), 1)
    except Exception:  # noqa: BLE001
        pass
    try:
        vals = await snmp.get(OID_NOKIA_MEM_USED, OID_NOKIA_MEM_AVAIL)
        used = int(vals[OID_NOKIA_MEM_USED])
        avail = int(vals[OID_NOKIA_MEM_AVAIL])
        if used + avail > 0:
            return round(used / (used + avail) * 100, 1)
    except Exception:  # noqa: BLE001
        pass
    return None


async def _run_collection(
    device_id: uuid.UUID, snmp: _Snmp, counters: dict | None = None
) -> dict:
    """Poll one device. Returns {facts, cpu, mem, in_bps, out_bps}. Raises on
    timeout/SNMP errors.

    `counters` is the rate-delta store to advance (see _last_counters). The live
    traffic modal passes its OWN store so its ~1×/s peeks don't overwrite the
    background poll loop's last-sample snapshot and corrupt persisted rates."""
    if counters is None:
        counters = _last_counters
    try:
        sys_vals = await snmp.get(OID_SYS_DESCR, OID_SYS_UPTIME, OID_SYS_NAME)

        # CPU: average across hrProcessorLoad rows (servers/net-snmp), falling
        # back to vendor MIBs (Cisco/Juniper/Nokia gear rarely exposes HR).
        cpu: float | None = None
        try:
            loads = await snmp.walk(OID_HR_CPU_LOAD)
            if loads:
                vals = [int(v) for v in loads.values()]
                cpu = round(sum(vals) / len(vals), 1)
        except Exception:  # noqa: BLE001 — optional MIB
            pass
        if cpu is None:
            cpu = await _vendor_cpu(snmp)

        # Memory via hrStorage, falling back to vendor MIBs.
        mem: float | None = None
        try:
            descrs = await snmp.walk(OID_HR_STORAGE_DESCR)
            if descrs:
                units = await snmp.walk(OID_HR_STORAGE_UNITS)
                sizes = await snmp.walk(OID_HR_STORAGE_SIZE)
                useds = await snmp.walk(OID_HR_STORAGE_USED)
                mem = _mem_percent(descrs, units, sizes, useds)
        except Exception:  # noqa: BLE001
            pass
        if mem is None:
            mem = await _vendor_mem(snmp)

        # Interfaces: names + oper status + counters (prefer 64-bit HC). These
        # walks are independent, so run them concurrently — the engine multiplexes
        # by request-id, and this hot path also backs the ~1×/s traffic modal, so
        # overlapping the round-trips keeps the live poll snappy. descr/oper are
        # required (their exception classifies the whole poll); the rest tolerate
        # failure, exactly as the sequential version did.
        if_descr, if_oper, if_names, hc_in, hc_out, speeds = await asyncio.gather(
            snmp.walk(OID_IF_DESCR),
            snmp.walk(OID_IF_OPER_STATUS),
            snmp.walk(OID_IF_NAME),
            snmp.walk(OID_IF_HC_IN),
            snmp.walk(OID_IF_HC_OUT),
            snmp.walk(OID_IF_HIGH_SPEED),  # Mbps
            return_exceptions=True,
        )
        if isinstance(if_descr, BaseException):
            raise if_descr
        if isinstance(if_oper, BaseException):
            raise if_oper
        if isinstance(if_names, BaseException):
            if_names = {}
        in_octets = {} if isinstance(hc_in, BaseException) else hc_in
        out_octets = {} if isinstance(hc_out, BaseException) else hc_out
        hc = True
        if not in_octets:  # no HC counters — fall back to 32-bit ifInOctets
            hc = False
            in_octets = await snmp.walk(OID_IF_IN_OCTETS)
            out_octets = await snmp.walk(OID_IF_OUT_OCTETS)
        if isinstance(speeds, BaseException):
            speeds = {}
    finally:
        snmp.close()

    # ── Rates from counter deltas ────────────────────────────────────────────
    now_mono = time.monotonic()
    prev = counters.get(device_id)
    rates: dict[int, tuple[float, float]] = {}
    if prev and prev.get("hc") == hc:
        dt = now_mono - prev["t"]
        if 0 < dt < 3600:
            wrap = 2**64 if hc else 2**32
            for idx in in_octets:
                if idx not in prev["if"]:
                    continue
                p_in, p_out = prev["if"][idx]
                d_in = (int(in_octets[idx]) - p_in) % wrap
                d_out = (int(out_octets.get(idx, 0)) - p_out) % wrap
                rates[idx] = (d_in * 8 / dt, d_out * 8 / dt)
    counters[device_id] = {
        "t": now_mono,
        "hc": hc,
        "if": {i: (int(in_octets[i]), int(out_octets.get(i, 0))) for i in in_octets},
    }

    interfaces = []
    total_in = total_out = 0.0
    have_rates = bool(rates)
    for idx in sorted(if_descr):
        r_in, r_out = rates.get(idx, (None, None))
        if r_in is not None:
            total_in += r_in
            total_out += r_out
        interfaces.append(
            {
                "index": idx,
                "name": str(if_names.get(idx) or if_descr[idx]),
                "oper": "up" if int(if_oper.get(idx, 2)) == 1 else "down",
                "speed_mbps": int(speeds[idx]) if idx in speeds else None,
                "in_bps": round(r_in) if r_in is not None else None,
                "out_bps": round(r_out) if r_out is not None else None,
            }
        )

    uptime_ticks = sys_vals.get(OID_SYS_UPTIME)
    facts = {
        "sys_name": str(sys_vals.get(OID_SYS_NAME)) if OID_SYS_NAME in sys_vals else None,
        "sys_descr": str(sys_vals.get(OID_SYS_DESCR))[:500] if OID_SYS_DESCR in sys_vals else None,
        "uptime": _format_uptime(int(uptime_ticks)) if uptime_ticks is not None else None,
        "cpu_percent": cpu,
        "mem_percent": mem,
        "interfaces": interfaces,
    }
    return {
        "facts": facts,
        "cpu": cpu,
        "mem": mem,
        "in_bps": round(total_in) if have_rates else None,
        "out_bps": round(total_out) if have_rates else None,
    }


async def collect_device(device_id: uuid.UUID) -> dict | None:
    """Poll one device over SNMP and persist facts + a history sample. Returns
    a summary dict, or None if the device is missing / SNMP not configured."""
    # Phase 1: read config, then release the pool connection before the (slow,
    # multi-walk) SNMP poll — otherwise one pool connection is pinned per collect.
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
        if device is None or not device.snmp_enabled:
            return None
        is_v3 = device.snmp_version == "3"
        if (is_v3 and not device.snmp_v3_user) or (not is_v3 and not device.snmp_community):
            device.snmp_status = "error"
            device.snmp_collected_at = datetime.now(timezone.utc)
            await session.commit()
            missing = "snmp_v3_user" if is_v3 else "snmp_community"
            return {"status": "error", "detail": f"no {missing} set"}

        host = str(device.ip_address)
        snmp = _Snmp(
            host,
            device.snmp_port or 161,
            community=None if is_v3 else device.snmp_community,
            v3_user=device.snmp_v3_user if is_v3 else None,
            v3_auth_proto=device.snmp_v3_auth_proto or "sha",
            v3_auth_key=device.snmp_v3_auth_key,
            v3_priv_proto=device.snmp_v3_priv_proto or "aes",
            v3_priv_key=device.snmp_v3_priv_key,
        )

    # Phase 2: SNMP poll with NO DB connection held.
    status = "ok"
    detail = None
    result: dict | None = None
    try:
        result = await _run_collection(device_id, snmp)
    except Exception as exc:  # noqa: BLE001 — classify
        status = "timeout" if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) else "error"
        detail = f"{type(exc).__name__}: {exc}"
        logger.info("snmp collect %s (%s) → %s", host, status, detail)

    # Phase 3: persist on a fresh short-lived session.
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
        if device is None:
            return None
        now = datetime.now(timezone.utc)
        device.snmp_status = status
        device.snmp_collected_at = now
        if result is not None:
            device.snmp_facts = json.dumps(result["facts"], ensure_ascii=False)
            session.add(
                SnmpHistory(
                    ts=now,
                    device_id=device.id,
                    cpu_percent=result["cpu"],
                    mem_percent=result["mem"],
                    in_bps=result["in_bps"],
                    out_bps=result["out_bps"],
                )
            )
        await session.commit()
        await session.refresh(device)
        await state_cache.upsert_device(serialize_device(device))

        return {"status": status, "detail": detail, **({"facts": result["facts"]} if result else {})}


async def peek_device(device_id: uuid.UUID, device: Device | None = None) -> dict | None:
    """Poll a device over SNMP and return facts WITHOUT persisting anything —
    no history sample, no audit, no cache/DB write. Backs the live traffic
    modal, which polls ~1×/s: persisting every one of those would flood the
    audit log and snmp_history. Rates stay correct because _run_collection
    advances the in-memory _peek_counters delta chain (kept separate from the
    background loop's _last_counters so the two never corrupt each other).

    `device`, when the caller has already loaded and validated it (the snmp-peek
    route does), is reused to avoid a redundant DB round-trip on this hot path.

    Returns {status, detail?, facts?} or None if SNMP isn't configured."""
    if device is None:
        async with AsyncSessionLocal() as session:
            device = await session.get(Device, device_id)
    if device is None or not device.snmp_enabled:
        return None
    is_v3 = device.snmp_version == "3"
    if (is_v3 and not device.snmp_v3_user) or (not is_v3 and not device.snmp_community):
        return {"status": "error", "detail": "SNMP credentials not set"}

    try:
        snmp = _Snmp(
            str(device.ip_address),
            device.snmp_port or 161,
            community=None if is_v3 else device.snmp_community,
            v3_user=device.snmp_v3_user if is_v3 else None,
            v3_auth_proto=device.snmp_v3_auth_proto or "sha",
            v3_auth_key=device.snmp_v3_auth_key,
            v3_priv_proto=device.snmp_v3_priv_proto or "aes",
            v3_priv_key=device.snmp_v3_priv_key,
        )
        result = await _run_collection(device.id, snmp, counters=_peek_counters)
    except Exception as exc:  # noqa: BLE001 — classify like collect_device
        status = "timeout" if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) else "error"
        return {"status": status, "detail": f"{type(exc).__name__}: {exc}"}
    return {"status": "ok", "detail": None, "facts": result["facts"]}


# ── Comprehensive inventory (on-demand full SNMP walk) ───────────────────────
# Value-decode helpers (pysnmp objects → plain JSON-able Python).
def _as_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _as_str(value: object) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _mac(value: object) -> str | None:
    """OctetString (ifPhysAddress / neighbour PhysAddress) → aa:bb:cc:dd:ee:ff."""
    try:
        raw = bytes(value.asOctets())  # type: ignore[attr-defined]
    except (AttributeError, TypeError):
        return None
    if not raw or len(raw) > 8:
        return None
    return ":".join(f"{b:02x}" for b in raw)


def _vendor_from_oid(oid: str | None) -> str | None:
    parts = (oid or "").split(".")
    if len(parts) >= 7 and parts[:6] == ["1", "3", "6", "1", "4", "1"]:
        try:
            return _ENTERPRISE_VENDORS.get(int(parts[6]))
        except ValueError:
            return None
    return None


def _prefix_len(mask_octets: list[str]) -> int:
    try:
        return sum(bin(int(o)).count("1") for o in mask_octets)
    except ValueError:
        return 0


async def _safe_walk(snmp: _Snmp, oid: str) -> dict[int, object]:
    try:
        return await snmp.walk(oid)
    except Exception:  # noqa: BLE001 — optional column
        return {}


async def _safe_walk_full(snmp: _Snmp, oid: str, max_rows: int | None = None) -> dict[str, object]:
    try:
        return await snmp.walk_full(oid, max_rows=max_rows)
    except Exception:  # noqa: BLE001
        return {}


async def _inv_system(snmp: _Snmp) -> dict:
    scalars = await snmp.get(
        OID_SYS_NAME, OID_SYS_DESCR, OID_SYS_UPTIME, OID_SYS_OBJECT_ID,
        OID_SYS_CONTACT, OID_SYS_LOCATION,
    )
    uptime = scalars.get(OID_SYS_UPTIME)
    sys_obj = _as_str(scalars.get(OID_SYS_OBJECT_ID))
    out = {
        "sys_name": _as_str(scalars.get(OID_SYS_NAME)),
        "sys_descr": (_as_str(scalars.get(OID_SYS_DESCR)) or "")[:500] or None,
        "uptime": _format_uptime(int(uptime)) if uptime is not None else None,
        "contact": _as_str(scalars.get(OID_SYS_CONTACT)),
        "location": _as_str(scalars.get(OID_SYS_LOCATION)),
        "vendor": _vendor_from_oid(sys_obj),
        "object_id": sys_obj,
        "model": None, "serial": None,
        "hardware_rev": None, "firmware_rev": None, "software_rev": None,
    }
    # ENTITY-MIB chassis row → model / serial / revisions.
    classes = await _safe_walk(snmp, OID_ENT_CLASS)
    models = await _safe_walk(snmp, OID_ENT_MODEL)
    serials = await _safe_walk(snmp, OID_ENT_SERIAL)
    chassis = [i for i, c in classes.items() if _as_int(c) == 3]
    idx = chassis[0] if chassis else (next(iter(serials), None) or next(iter(models), None))
    if idx is not None:
        out["model"] = _as_str(models.get(idx))
        out["serial"] = _as_str(serials.get(idx))
        out["hardware_rev"] = _as_str((await _safe_walk(snmp, OID_ENT_HW_REV)).get(idx))
        out["software_rev"] = _as_str((await _safe_walk(snmp, OID_ENT_SW_REV)).get(idx))
        out["firmware_rev"] = _as_str((await _safe_walk(snmp, OID_ENT_FW_REV)).get(idx))
    return out


async def _inv_resources(snmp: _Snmp) -> dict:
    cpu: float | None = None
    cores: list[int] = []
    try:
        loads = await snmp.walk(OID_HR_CPU_LOAD)
        cores = [c for c in (_as_int(v) for v in loads.values()) if c is not None]
        if cores:
            cpu = round(sum(cores) / len(cores), 1)
    except Exception:  # noqa: BLE001
        pass
    if cpu is None:
        cpu = await _vendor_cpu(snmp)
    mem: float | None = None
    try:
        descrs = await snmp.walk(OID_HR_STORAGE_DESCR)
        if descrs:
            mem = _mem_percent(
                descrs,
                await snmp.walk(OID_HR_STORAGE_UNITS),
                await snmp.walk(OID_HR_STORAGE_SIZE),
                await snmp.walk(OID_HR_STORAGE_USED),
            )
    except Exception:  # noqa: BLE001
        pass
    if mem is None:
        mem = await _vendor_mem(snmp)
    return {"cpu_percent": cpu, "cores": cores, "mem_percent": mem}


async def _inv_storage(snmp: _Snmp) -> list[dict]:
    descrs = await snmp.walk(OID_HR_STORAGE_DESCR)
    if not descrs:
        return []
    types = await _safe_walk(snmp, OID_HR_STORAGE_TYPE)
    units = await _safe_walk(snmp, OID_HR_STORAGE_UNITS)
    sizes = await _safe_walk(snmp, OID_HR_STORAGE_SIZE)
    useds = await _safe_walk(snmp, OID_HR_STORAGE_USED)
    out = []
    for idx, descr in sorted(descrs.items()):
        size = _as_int(sizes.get(idx))
        if size is None:
            continue
        unit = _as_int(units.get(idx)) or 1
        used = _as_int(useds.get(idx)) or 0
        type_oid = _as_str(types.get(idx)) or ""
        kind = "disk" if type_oid == OID_HR_TYPE_FIXED_DISK else "ram" if type_oid == OID_HR_TYPE_RAM else "other"
        size_b, used_b = size * unit, used * unit
        out.append({
            "descr": _as_str(descr), "kind": kind,
            "size_bytes": size_b, "used_bytes": used_b,
            "pct": round(used_b / size_b * 100, 1) if size_b > 0 else None,
        })
    return out


async def _inv_interfaces(snmp: _Snmp) -> list[dict]:
    descrs = await snmp.walk(OID_IF_DESCR)
    if not descrs:
        return []
    names = await _safe_walk(snmp, OID_IF_NAME)
    aliases = await _safe_walk(snmp, OID_IF_ALIAS)
    oper = await _safe_walk(snmp, OID_IF_OPER_STATUS)
    admin = await _safe_walk(snmp, OID_IF_ADMIN_STATUS)
    types = await _safe_walk(snmp, OID_IF_TYPE)
    mtus = await _safe_walk(snmp, OID_IF_MTU)
    macs = await _safe_walk(snmp, OID_IF_PHYS)
    speeds = await _safe_walk(snmp, OID_IF_HIGH_SPEED)
    in_err = await _safe_walk(snmp, OID_IF_IN_ERRORS)
    out_err = await _safe_walk(snmp, OID_IF_OUT_ERRORS)
    in_disc = await _safe_walk(snmp, OID_IF_IN_DISCARDS)
    out_disc = await _safe_walk(snmp, OID_IF_OUT_DISCARDS)
    out = []
    for idx in sorted(descrs):
        out.append({
            "index": idx,
            "name": _as_str(names.get(idx)) or _as_str(descrs.get(idx)),
            "descr": _as_str(descrs.get(idx)),
            "alias": _as_str(aliases.get(idx)),
            "oper": "up" if _as_int(oper.get(idx)) == 1 else "down",
            "admin": "up" if _as_int(admin.get(idx)) == 1 else "down",
            "type": _as_int(types.get(idx)),
            "mtu": _as_int(mtus.get(idx)),
            "mac": _mac(macs.get(idx)),
            "speed_mbps": _as_int(speeds.get(idx)),
            "in_errors": _as_int(in_err.get(idx)),
            "out_errors": _as_int(out_err.get(idx)),
            "in_discards": _as_int(in_disc.get(idx)),
            "out_discards": _as_int(out_disc.get(idx)),
        })
    return out


async def _inv_sensors(snmp: _Snmp) -> list[dict]:
    out: list[dict] = []
    types = await _safe_walk(snmp, OID_SENSOR_TYPE)
    if types:
        values = await _safe_walk(snmp, OID_SENSOR_VALUE)
        precisions = await _safe_walk(snmp, OID_SENSOR_PRECISION)
        statuses = await _safe_walk(snmp, OID_SENSOR_STATUS)
        units = await _safe_walk(snmp, OID_SENSOR_UNITS)
        names = await _safe_walk(snmp, OID_ENT_NAME)
        for idx, t in sorted(types.items()):
            raw = _as_int(values.get(idx))
            if raw is None:
                continue
            tv = _as_int(t) or 0
            prec = _as_int(precisions.get(idx)) or 0
            val = raw / (10 ** prec) if prec else float(raw)
            out.append({
                "name": _as_str(names.get(idx)) or f"sensor {idx}",
                "kind": _SENSOR_KIND.get(tv, "other"),
                "value": round(val, 2),
                "unit": _as_str(units.get(idx)) or _SENSOR_UNIT.get(tv),
                "status": "ok" if _as_int(statuses.get(idx)) == 1 else "warn",
            })
        if out:
            return out
    # Cisco CISCO-ENVMON-MIB fallback.
    for descr_oid, val_oid, state_oid, kind, unit in (
        (OID_CENV_TEMP_DESCR, OID_CENV_TEMP_VALUE, OID_CENV_TEMP_STATE, "temperature", "°C"),
        (OID_CENV_FAN_DESCR, None, OID_CENV_FAN_STATE, "fan", None),
        (OID_CENV_SUPPLY_DESCR, None, OID_CENV_SUPPLY_STATE, "power", None),
    ):
        descrs = await _safe_walk(snmp, descr_oid)
        vals = await _safe_walk(snmp, val_oid) if val_oid else {}
        states = await _safe_walk(snmp, state_oid)
        for i, d in sorted(descrs.items()):
            out.append({
                "name": _as_str(d), "kind": kind,
                "value": _as_int(vals.get(i)) if val_oid else None, "unit": unit,
                "status": "ok" if _as_int(states.get(i)) == 1 else "warn",
            })
    return out


async def _inv_vlans(snmp: _Snmp) -> list[dict]:
    names = await _safe_walk(snmp, OID_DOT1Q_VLAN_NAME) or await _safe_walk(snmp, OID_CISCO_VTP_VLAN_NAME)
    return [{"id": idx, "name": _as_str(name)} for idx, name in sorted(names.items())]


async def _inv_mac_table(snmp: _Snmp, max_rows: int = 1000) -> list[dict]:
    base_if = await _safe_walk(snmp, OID_DOT1D_BASE_PORT_IF)
    out: list[dict] = []
    q = await _safe_walk_full(snmp, OID_DOT1Q_FDB_PORT, max_rows)
    if q:
        for suffix, port in q.items():
            parts = suffix.split(".")
            if len(parts) < 7:
                continue
            bport = _as_int(port)
            out.append({
                "vlan": int(parts[0]),
                "mac": ":".join(f"{int(p):02x}" for p in parts[1:7]),
                "port": bport,
                "ifindex": _as_int(base_if.get(bport)) if bport else None,
            })
        return out
    d = await _safe_walk_full(snmp, OID_DOT1D_FDB_PORT, max_rows)
    for suffix, port in d.items():
        parts = suffix.split(".")
        if len(parts) < 6:
            continue
        bport = _as_int(port)
        out.append({
            "vlan": None,
            "mac": ":".join(f"{int(p):02x}" for p in parts[0:6]),
            "port": bport,
            "ifindex": _as_int(base_if.get(bport)) if bport else None,
        })
    return out


async def _inv_arp(snmp: _Snmp, max_rows: int = 1000) -> list[dict]:
    phys = await _safe_walk_full(snmp, OID_ARP_PHYS, max_rows)
    out = []
    for suffix, val in phys.items():
        parts = suffix.split(".")
        if len(parts) < 5:
            continue
        mac = _mac(val)
        if mac:
            out.append({"ip": ".".join(parts[1:5]), "mac": mac, "ifindex": int(parts[0])})
    return out


async def _inv_routes(snmp: _Snmp, max_rows: int = 500) -> list[dict]:
    out: list[dict] = []
    ifidx = await _safe_walk_full(snmp, OID_IPCIDR_ROUTE_IFINDEX, max_rows)
    if ifidx:
        protos = await _safe_walk_full(snmp, OID_IPCIDR_ROUTE_PROTO, max_rows)
        for suffix, iface in ifidx.items():
            parts = suffix.split(".")
            if len(parts) < 13:
                continue
            out.append({
                "dest": f"{'.'.join(parts[0:4])}/{_prefix_len(parts[4:8])}",
                "nexthop": ".".join(parts[9:13]),
                "ifindex": _as_int(iface),
                "proto": _as_int(protos.get(suffix)),
            })
        return out
    ifidx = await _safe_walk_full(snmp, OID_IPROUTE_IFINDEX, max_rows)
    nexthops = await _safe_walk_full(snmp, OID_IPROUTE_NEXTHOP, max_rows)
    masks = await _safe_walk_full(snmp, OID_IPROUTE_MASK, max_rows)
    for suffix, iface in ifidx.items():
        mask = _as_str(masks.get(suffix))
        plen = _prefix_len(mask.split(".")) if mask else None
        out.append({
            "dest": f"{suffix}/{plen}" if plen is not None else suffix,
            "nexthop": _as_str(nexthops.get(suffix)),
            "ifindex": _as_int(iface),
            "proto": None,
        })
    return out


async def _inv_ups(snmp: _Snmp) -> dict | None:
    try:
        scalars = await snmp.get(
            OID_UPS_BATTERY_STATUS, OID_UPS_MINUTES_REMAIN,
            OID_UPS_CHARGE_PCT, OID_UPS_SECONDS_ON_BATT,
        )
    except Exception:  # noqa: BLE001
        return None
    if not scalars:
        return None
    battery_map = {1: "unknown", 2: "normal", 3: "low", 4: "depleted"}
    loads = await _safe_walk(snmp, OID_UPS_OUT_LOAD)
    in_v = await _safe_walk(snmp, OID_UPS_IN_VOLTAGE)
    out_v = await _safe_walk(snmp, OID_UPS_OUT_VOLTAGE)
    first = lambda w: next((v for v in (_as_int(x) for x in w.values()) if v is not None), None)  # noqa: E731
    return {
        "battery_status": battery_map.get(_as_int(scalars.get(OID_UPS_BATTERY_STATUS)) or 1, "unknown"),
        "charge_pct": _as_int(scalars.get(OID_UPS_CHARGE_PCT)),
        "minutes_remaining": _as_int(scalars.get(OID_UPS_MINUTES_REMAIN)),
        "seconds_on_battery": _as_int(scalars.get(OID_UPS_SECONDS_ON_BATT)),
        "output_load_pct": first(loads),
        "input_voltage": first(in_v),
        "output_voltage": first(out_v),
    }


async def _inv_qos(snmp: _Snmp) -> list[dict]:
    out = [{"kind": "policy-map", "name": _as_str(n)} for _, n in sorted((await _safe_walk(snmp, OID_CBQOS_POLICYMAP_NAME)).items())]
    out += [{"kind": "class-map", "name": _as_str(n)} for _, n in sorted((await _safe_walk(snmp, OID_CBQOS_CM_NAME)).items())]
    return out


async def _inv_vpn(snmp: _Snmp) -> list[dict]:
    peers = await _safe_walk(snmp, OID_IPSEC_TUN_PEER)
    status = await _safe_walk(snmp, OID_IPSEC_TUN_STATUS)
    return [
        {"peer": _as_str(p), "status": "active" if _as_int(status.get(i)) == 1 else "inactive"}
        for i, p in sorted(peers.items())
    ]


async def _inv_wireless(snmp: _Snmp) -> list[dict]:
    return [{"name": _as_str(n)} for _, n in sorted((await _safe_walk(snmp, OID_CISCO_AP_NAME)).items())]


async def inventory_device(device_id: uuid.UUID) -> dict | None:
    """On-demand comprehensive SNMP walk. Gathers every category best-effort
    (each isolated — one unsupported table never sinks the rest) and persists
    NOTHING (no history, no cache, no audit). Backs the SNMP Explorer modal.

    Returns {status, detail?, data?} or None if SNMP isn't configured."""
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
    if device is None or not device.snmp_enabled:
        return None
    is_v3 = device.snmp_version == "3"
    if (is_v3 and not device.snmp_v3_user) or (not is_v3 and not device.snmp_community):
        return {"status": "error", "detail": "SNMP credentials not set"}

    try:
        snmp = _Snmp(
            str(device.ip_address),
            device.snmp_port or 161,
            community=None if is_v3 else device.snmp_community,
            v3_user=device.snmp_v3_user if is_v3 else None,
            v3_auth_proto=device.snmp_v3_auth_proto or "sha",
            v3_auth_key=device.snmp_v3_auth_key,
            v3_priv_proto=device.snmp_v3_priv_proto or "aes",
            v3_priv_key=device.snmp_v3_priv_key,
        )
    except ValueError as exc:  # misconfigured v3 credentials — surface, don't poll
        return {"status": "error", "detail": str(exc)}

    async def cat(coro):
        try:
            return await coro
        except Exception as exc:  # noqa: BLE001 — isolate each category
            logger.debug("snmp inventory category failed: %s", exc)
            return None

    async with _sem:
        try:
            # System first — if the device is unreachable this raises and we
            # classify the whole poll as a timeout/error (nothing else will answer).
            try:
                system = await _inv_system(snmp)
            except Exception as exc:  # noqa: BLE001
                status = "timeout" if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) else "error"
                return {"status": status, "detail": f"{type(exc).__name__}: {exc}"}

            data: dict = {"system": system}
            data["resources"] = await cat(_inv_resources(snmp)) or {}
            data["storage"] = await cat(_inv_storage(snmp)) or []
            data["interfaces"] = await cat(_inv_interfaces(snmp)) or []
            data["sensors"] = await cat(_inv_sensors(snmp)) or []
            data["vlans"] = await cat(_inv_vlans(snmp)) or []
            data["mac_table"] = await cat(_inv_mac_table(snmp)) or []
            data["arp"] = await cat(_inv_arp(snmp)) or []
            data["routes"] = await cat(_inv_routes(snmp)) or []
            data["qos"] = await cat(_inv_qos(snmp)) or []
            data["vpn"] = await cat(_inv_vpn(snmp)) or []
            data["wireless"] = await cat(_inv_wireless(snmp)) or []
            data["ups"] = await cat(_inv_ups(snmp))
        finally:
            snmp.close()

    present = ["system"]
    for key in ("resources", "storage", "interfaces", "sensors", "vlans",
                "mac_table", "arp", "routes", "qos", "vpn", "wireless"):
        v = data.get(key)
        if v:
            present.append(key)
    if data.get("ups"):
        present.append("ups")
    data["meta"] = {
        "categories_with_data": present,
        "collected_at": datetime.now(timezone.utc).isoformat(),
    }
    return {"status": "ok", "detail": None, "data": data}


# ── Background poll loop ──────────────────────────────────────────────────────
async def snmp_poll_loop() -> None:
    if not settings.SNMP_ENABLED:
        logger.info("SNMP collector disabled (SNMP_ENABLED=false)")
        return

    interval = settings.SNMP_POLL_INTERVAL_SECONDS
    logger.info("SNMP collector started — interval=%ds", interval)
    while True:
        start = time.monotonic()
        try:
            async with AsyncSessionLocal() as session:
                ids = list(
                    await session.scalars(
                        select(Device.id).where(
                            Device.snmp_enabled.is_(True),
                            Device.is_enabled.is_(True),
                        )
                    )
                )

            async def run(did: uuid.UUID) -> None:
                async with _sem:
                    try:
                        await collect_device(did)
                    except Exception as exc:
                        logger.error("snmp collect failed for %s: %s", did, exc)

            if ids:
                await asyncio.gather(*(run(d) for d in ids))
        except Exception as exc:
            logger.error("snmp poll tick error: %s", exc, exc_info=True)

        elapsed = time.monotonic() - start
        await asyncio.sleep(max(1.0, interval - elapsed))
