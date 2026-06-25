import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role
from app.core.config import settings
from app.db.session import get_db
from app.models import Device, EventLog, User
from app.models.device import DeviceStatus
from app.models.event_log import EventType
from app.schemas.device import DeviceCreate, DeviceRead, DeviceSimulate, DeviceUpdate
from app.services.ws_manager import ws_manager

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.get("", response_model=list[DeviceRead])
async def list_devices(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Device]:
    result = await db.scalars(select(Device).order_by(Device.created_at))
    return list(result.all())


@router.post("", response_model=DeviceRead, status_code=status.HTTP_201_CREATED)
async def create_device(
    body: DeviceCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role("manager")),
) -> Device:
    device = Device(**body.model_dump(), created_by=current_user.id)
    db.add(device)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A device with this IP address already exists")
    await db.refresh(device)
    return device


@router.get("/{device_id}", response_model=DeviceRead)
async def get_device(
    device_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.patch("/{device_id}", response_model=DeviceRead)
async def update_device(
    device_id: uuid.UUID,
    body: DeviceUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_role("manager")),
) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(device, field, value)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A device with this IP address already exists")
    await db.refresh(device)
    return device


@router.post("/{device_id}/simulate", response_model=DeviceRead)
async def simulate_device_status(
    device_id: uuid.UUID,
    body: DeviceSimulate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_role("manager")),
) -> Device:
    """Manually mark a device online/offline (testing). Logs an event and
    broadcasts the change exactly like the real ping loop would."""
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    new_status = DeviceStatus(body.status)
    now = datetime.now(timezone.utc)
    prev_status = device.current_status

    device.last_checked_at = now
    device.current_status = new_status
    device.consecutive_failures = 0 if new_status == DeviceStatus.online else settings.FLAP_THRESHOLD

    if new_status != prev_status:
        event_type = (
            EventType.came_online
            if new_status == DeviceStatus.online
            else EventType.went_offline
        )
        db.add(EventLog(device_id=device.id, event_type=event_type))

    await db.commit()
    await db.refresh(device)

    if new_status != prev_status:
        await ws_manager.broadcast(device.id, new_status.value, now)

    return device


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    device_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_role("manager")),
) -> None:
    device = await db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    await db.delete(device)
    await db.commit()
