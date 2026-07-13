import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_permission
from app.core.permissions import EDIT_DEVICE
from app.db.session import get_db
from app.models import Device, DeviceLink, User
from app.services.audit import add_audit

router = APIRouter(prefix="/api/device-links", tags=["device-links"])


class DeviceLinkRead(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    source_id: uuid.UUID
    target_id: uuid.UUID
    kind: str
    label: str | None
    created_at: datetime


class DeviceLinkCreate(BaseModel):
    source_id: uuid.UUID
    target_id: uuid.UUID
    kind: Literal["physical", "logical"] = "physical"
    label: str | None = None


@router.get("", response_model=list[DeviceLinkRead])
async def list_links(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[DeviceLink]:
    return list(await db.scalars(select(DeviceLink)))


@router.post("", response_model=DeviceLinkRead, status_code=status.HTTP_201_CREATED)
async def create_link(
    body: DeviceLinkCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> DeviceLink:
    if body.source_id == body.target_id:
        raise HTTPException(status_code=422, detail="A device cannot link to itself")

    ids = set(await db.scalars(select(Device.id).where(Device.id.in_([body.source_id, body.target_id]))))
    if body.source_id not in ids or body.target_id not in ids:
        raise HTTPException(status_code=404, detail="Both source and target devices must exist")

    link = DeviceLink(
        source_id=body.source_id,
        target_id=body.target_id,
        kind=body.kind,
        label=(body.label or None),
        created_by=current_user.id,
    )
    db.add(link)
    add_audit(
        db, current_user, "device_link.create",
        target_type="device", target_id=str(body.target_id),
        detail=f"{body.kind}: {body.source_id} → {body.target_id}",
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="This link already exists")
    await db.refresh(link)
    return link


@router.delete("/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_link(
    link_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(EDIT_DEVICE)),
) -> None:
    link = await db.get(DeviceLink, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Link not found")
    add_audit(
        db, current_user, "device_link.delete",
        target_type="device", target_id=str(link.target_id),
        detail=f"{link.kind}: {link.source_id} → {link.target_id}",
    )
    await db.delete(link)
    await db.commit()
