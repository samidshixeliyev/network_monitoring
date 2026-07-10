import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import SyslogMessage, User

router = APIRouter(prefix="/api/syslog", tags=["syslog"])


class SyslogRead(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    ts: datetime
    host: str
    device_id: uuid.UUID | None
    facility: int | None
    severity: int
    app_name: str | None
    message: str


class PaginatedSyslog(BaseModel):
    total: int
    items: list[SyslogRead]


@router.get("", response_model=PaginatedSyslog)
async def list_syslog(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    device_id: uuid.UUID | None = Query(None),
    host: str | None = Query(None),
    # Show messages at or below this severity number (0=emerg … 7=debug).
    max_severity: int | None = Query(None, ge=0, le=7),
    q: str | None = Query(None, max_length=200, description="substring match on message"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> PaginatedSyslog:
    stmt = select(SyslogMessage)
    count_stmt = select(func.count()).select_from(SyslogMessage)

    conds = []
    if device_id is not None:
        conds.append(SyslogMessage.device_id == device_id)
    if host:
        conds.append(SyslogMessage.host == host)
    if max_severity is not None:
        conds.append(SyslogMessage.severity <= max_severity)
    if q:
        conds.append(SyslogMessage.message.ilike(f"%{q}%"))
    if conds:
        stmt = stmt.where(*conds)
        count_stmt = count_stmt.where(*conds)

    offset = (page - 1) * page_size
    total = await db.scalar(count_stmt) or 0
    rows = list(
        await db.scalars(stmt.order_by(SyslogMessage.ts.desc()).offset(offset).limit(page_size))
    )
    return PaginatedSyslog(total=total, items=rows)
