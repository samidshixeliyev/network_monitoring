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

# Last-seen interface counters per device, for rate computation between polls:
# {device_id: {"t": monotonic, "if": {ifindex: (in_octets, out_octets)}}}
_last_counters: dict[uuid.UUID, dict] = {}


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


class _Snmp:
    """Thin wrapper around pysnmp v1arch asyncio for GET + WALK with v2c."""

    def __init__(self, host: str, port: int, community: str):
        from pysnmp.hlapi.v1arch.asyncio import CommunityData, SnmpDispatcher

        self.host = host
        self.port = port
        self.dispatcher = SnmpDispatcher()
        self.auth = CommunityData(community, mpModel=1)  # v2c

    async def _target(self):
        from pysnmp.hlapi.v1arch.asyncio import UdpTransportTarget

        return await UdpTransportTarget.create(
            (self.host, self.port),
            timeout=settings.SNMP_TIMEOUT_SECONDS,
            retries=settings.SNMP_RETRIES,
        )

    async def get(self, *oids: str) -> dict[str, object]:
        """GET scalars. Returns {oid: value} (missing/noSuchObject omitted)."""
        from pysnmp.hlapi.v1arch.asyncio import ObjectIdentity, ObjectType, get_cmd

        err_ind, err_status, _err_idx, var_binds = await get_cmd(
            self.dispatcher, self.auth, await self._target(),
            *[ObjectType(ObjectIdentity(o)) for o in oids],
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
        from pysnmp.hlapi.v1arch.asyncio import ObjectIdentity, ObjectType, walk_cmd

        out: dict[int, object] = {}
        async for err_ind, err_status, _err_idx, var_binds in walk_cmd(
            self.dispatcher, self.auth, await self._target(),
            ObjectType(ObjectIdentity(base_oid)),
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

    def close(self) -> None:
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


async def _run_collection(device_id: uuid.UUID, host: str, port: int, community: str) -> dict:
    """Poll one device. Returns {facts, cpu, mem, in_bps, out_bps}. Raises on
    timeout/SNMP errors."""
    snmp = _Snmp(host, port, community)
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

        # Interfaces: names + oper status + counters (prefer 64-bit HC).
        if_descr = await snmp.walk(OID_IF_DESCR)
        if_oper = await snmp.walk(OID_IF_OPER_STATUS)
        try:
            if_names = await snmp.walk(OID_IF_NAME)
        except Exception:  # noqa: BLE001
            if_names = {}
        in_octets = out_octets = {}
        hc = True
        try:
            in_octets = await snmp.walk(OID_IF_HC_IN)
            out_octets = await snmp.walk(OID_IF_HC_OUT)
        except Exception:  # noqa: BLE001
            pass
        if not in_octets:
            hc = False
            in_octets = await snmp.walk(OID_IF_IN_OCTETS)
            out_octets = await snmp.walk(OID_IF_OUT_OCTETS)
        try:
            speeds = await snmp.walk(OID_IF_HIGH_SPEED)  # Mbps
        except Exception:  # noqa: BLE001
            speeds = {}
    finally:
        snmp.close()

    # ── Rates from counter deltas ────────────────────────────────────────────
    now_mono = time.monotonic()
    prev = _last_counters.get(device_id)
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
    _last_counters[device_id] = {
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
    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)
        if device is None or not device.snmp_enabled:
            return None
        if not device.snmp_community:
            device.snmp_status = "error"
            device.snmp_collected_at = datetime.now(timezone.utc)
            await session.commit()
            return {"status": "error", "detail": "no snmp_community set"}

        host = str(device.ip_address)
        port = device.snmp_port or 161
        community = device.snmp_community

        status = "ok"
        detail = None
        result: dict | None = None
        try:
            result = await _run_collection(device.id, host, port, community)
        except Exception as exc:  # noqa: BLE001 — classify
            status = "timeout" if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) else "error"
            detail = f"{type(exc).__name__}: {exc}"
            logger.info("snmp collect %s (%s) → %s", host, status, detail)

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
