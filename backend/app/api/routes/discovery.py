import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_permission
from app.core.config import settings
from app.core.permissions import EDIT_DEVICE
from app.db.session import get_db
from app.models import Device, DiscoveredDevice, User
from app.models.device import DeviceType
from app.schemas.device import DeviceRead, serialize_device
from app.services import state_cache
from app.services.audit import add_audit

router = APIRouter(prefix="/api/discovery", tags=["discovery"])


class DiscoveredRead(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    ip_address: str
    hostname: str | None
    rtt_ms: float | None
    status: str
    first_seen: datetime
    last_seen: datetime


class DiscoveryStatus(BaseModel):
    enabled: bool
    subnets: str
    interval_seconds: int
    pending: int
    ignored: int


class ApproveRequest(BaseModel):
    """Everything optional — sensible defaults let one-click approval work."""
    vendor_name: str | None = None
    device_type: DeviceType = DeviceType.other
    is_critical: bool = False
    latitude: float | None = None
    longitude: float | None = None
    location_text: str | None = None


@router.get("/status", response_model=DiscoveryStatus)
async def discovery_status(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> DiscoveryStatus:
    rows = list(await db.scalars(select(DiscoveredDevice.status)))
    return DiscoveryStatus(
        enabled=settings.DISCOVERY_ENABLED,
        subnets=settings.DISCOVERY_SUBNETS,
        interval_seconds=settings.DISCOVERY_INTERVAL_SECONDS,
        pending=sum(1 for s in rows if s == "new"),
        ignored=sum(1 for s in rows if s == "ignored"),
    )


@router.get("", response_model=list[DiscoveredRead])
async def list_discovered(
    include_ignored: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[DiscoveredDevice]:
    stmt = select(DiscoveredDevice).order_by(DiscoveredDevice.last_seen.desc())
    if not include_ignored:
        stmt = stmt.where(DiscoveredDevice.status == "new")
    return list(await db.scalars(stmt))


@router.post("/sweep")
async def sweep_now(
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> dict:
    """Run one discovery sweep right now (also works when the periodic loop is
    disabled, as long as DISCOVERY_SUBNETS is set)."""
    from app.services.discovery import run_sweep

    if not settings.DISCOVERY_SUBNETS.strip():
        raise HTTPException(status_code=400, detail="DISCOVERY_SUBNETS is not configured")
    return await run_sweep()


async def _get_row(db: AsyncSession, discovered_id: uuid.UUID) -> DiscoveredDevice:
    row = await db.get(DiscoveredDevice, discovered_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Discovered device not found")
    return row


@router.post("/{discovered_id}/approve", response_model=DeviceRead, status_code=status.HTTP_201_CREATED)
async def approve_discovered(
    discovered_id: uuid.UUID,
    body: ApproveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> Device:
    """Promote a pending IP to a monitored Device and drop the pending row."""
    row = await _get_row(db, discovered_id)
    device = Device(
        vendor_name=body.vendor_name or row.hostname or row.ip_address,
        ip_address=row.ip_address,
        description=f"Auto-discovered {row.first_seen:%Y-%m-%d}"
        + (f" ({row.hostname})" if row.hostname else ""),
        device_type=body.device_type,
        is_critical=body.is_critical,
        latitude=body.latitude,
        longitude=body.longitude,
        location_text=body.location_text,
        created_by=current_user.id,
    )
    db.add(device)
    await db.delete(row)
    add_audit(
        db, current_user, "discovery.approve",
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


@router.post("/{discovered_id}/ignore", response_model=DiscoveredRead)
async def ignore_discovered(
    discovered_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> DiscoveredDevice:
    row = await _get_row(db, discovered_id)
    row.status = "ignored"
    add_audit(
        db, current_user, "discovery.ignore",
        target_type="discovered", target_id=str(discovered_id), detail=row.ip_address,
    )
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/{discovered_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_discovered(
    discovered_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> None:
    """Forget an entry entirely (it may be re-proposed by the next sweep)."""
    row = await _get_row(db, discovered_id)
    add_audit(
        db, current_user, "discovery.delete",
        target_type="discovered", target_id=str(discovered_id), detail=row.ip_address,
    )
    await db.delete(row)
    await db.commit()
