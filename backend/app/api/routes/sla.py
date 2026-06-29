import csv
import io

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Device, User

router = APIRouter(prefix="/api/sla", tags=["sla"])

# range → SQL interval. Inlined (whitelist only) to dodge asyncpg interval-param typing.
_RANGES = {"day": "1 day", "week": "7 days", "month": "30 days"}


class DeviceSla(BaseModel):
    device_id: str
    vendor_name: str
    ip_address: str
    region: str | None
    is_critical: bool
    uptime_pct: float
    samples: int


class RegionSla(BaseModel):
    region: str
    uptime_pct: float
    devices: int
    samples: int


class SlaReport(BaseModel):
    range: str
    devices: list[DeviceSla]
    regions: list[RegionSla]


async def _compute(db: AsyncSession, range_key: str) -> SlaReport:
    interval = _RANGES.get(range_key, _RANGES["week"])
    rows = (
        await db.execute(
            text(
                f"""
                SELECT device_id,
                       count(*)                        AS total,
                       count(*) FILTER (WHERE success) AS up
                FROM ping_history
                WHERE ts >= now() - INTERVAL '{interval}'
                GROUP BY device_id
                """
            )
        )
    ).all()
    agg = {r.device_id: (int(r.total), int(r.up)) for r in rows}

    devices = list(await db.scalars(select(Device).order_by(Device.vendor_name)))
    dev_rows: list[DeviceSla] = []
    region_acc: dict[str, list[int]] = {}  # region → [up, total, device_count]
    for d in devices:
        total, up = agg.get(d.id, (0, 0))
        pct = round(up / total * 100, 2) if total else 0.0
        region = d.location_text or "—"
        dev_rows.append(
            DeviceSla(
                device_id=str(d.id), vendor_name=d.vendor_name, ip_address=str(d.ip_address),
                region=d.location_text, is_critical=d.is_critical, uptime_pct=pct, samples=total,
            )
        )
        acc = region_acc.setdefault(region, [0, 0, 0])
        acc[0] += up
        acc[1] += total
        acc[2] += 1

    regions = [
        RegionSla(
            region=region,
            uptime_pct=round(up / total * 100, 2) if total else 0.0,
            devices=cnt, samples=total,
        )
        for region, (up, total, cnt) in sorted(region_acc.items())
    ]
    return SlaReport(range=range_key, devices=dev_rows, regions=regions)


@router.get("", response_model=SlaReport)
async def sla_report(
    range: str = Query("week"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> SlaReport:
    """Per-device and per-region uptime % over day/week/month (from ping_history)."""
    return await _compute(db, range)


@router.get("/export")
async def sla_export(
    range: str = Query("week"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> StreamingResponse:
    """Same report as CSV for download."""
    report = await _compute(db, range)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["device", "ip", "region", "critical", "uptime_pct", "samples", "range"])
    for d in report.devices:
        w.writerow([
            d.vendor_name, d.ip_address, d.region or "", d.is_critical,
            d.uptime_pct, d.samples, report.range,
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=sla_{range}.csv"},
    )
