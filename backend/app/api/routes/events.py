import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import EventLog, User
from app.schemas.event_log import EventLogRead

router = APIRouter(prefix="/api/events", tags=["events"])


class PaginatedEvents(BaseModel):
    total: int
    items: list[EventLogRead]


@router.get("", response_model=PaginatedEvents)
async def list_events(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    device_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> PaginatedEvents:
    stmt = select(EventLog)
    count_stmt = select(func.count()).select_from(EventLog)

    if device_id is not None:
        stmt = stmt.where(EventLog.device_id == device_id)
        count_stmt = count_stmt.where(EventLog.device_id == device_id)

    offset = (page - 1) * page_size
    total = await db.scalar(count_stmt) or 0
    rows = list(
        await db.scalars(
            stmt.order_by(EventLog.created_at.desc()).offset(offset).limit(page_size)
        )
    )
    return PaginatedEvents(total=total, items=rows)
