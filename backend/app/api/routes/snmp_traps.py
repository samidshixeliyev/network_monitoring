import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import SnmpTrap, User

router = APIRouter(prefix="/api/snmp-traps", tags=["snmp-traps"])


class SnmpTrapRead(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    ts: datetime
    host: str
    device_id: uuid.UUID | None
    version: str
    trap_oid: str | None
    trap_name: str
    severity: int
    if_index: int | None
    message: str
    varbinds: str | None


class PaginatedSnmpTraps(BaseModel):
    total: int
    items: list[SnmpTrapRead]


@router.get("", response_model=PaginatedSnmpTraps)
async def list_snmp_traps(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    device_id: uuid.UUID | None = Query(None),
    host: str | None = Query(None),
    # Show traps at or below this severity number (0=emerg … 7=debug).
    max_severity: int | None = Query(None, ge=0, le=7),
    q: str | None = Query(None, max_length=200, description="substring match on message"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> PaginatedSnmpTraps:
    stmt = select(SnmpTrap)
    count_stmt = select(func.count()).select_from(SnmpTrap)

    conds = []
    if device_id is not None:
        conds.append(SnmpTrap.device_id == device_id)
    if host:
        conds.append(SnmpTrap.host == host)
    if max_severity is not None:
        conds.append(SnmpTrap.severity <= max_severity)
    if q:
        conds.append(SnmpTrap.message.ilike(f"%{q}%"))
    if conds:
        stmt = stmt.where(*conds)
        count_stmt = count_stmt.where(*conds)

    offset = (page - 1) * page_size
    total = await db.scalar(count_stmt) or 0
    rows = list(
        await db.scalars(stmt.order_by(SnmpTrap.ts.desc()).offset(offset).limit(page_size))
    )
    return PaginatedSnmpTraps(total=total, items=rows)
