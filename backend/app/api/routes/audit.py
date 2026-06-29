from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.core.permissions import MANAGE_USERS
from app.db.session import get_db
from app.models import AuditLog, User

router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    user_email: str | None
    action: str
    target_type: str | None
    target_id: str | None
    detail: str | None
    created_at: datetime


class PaginatedAudit(BaseModel):
    total: int
    items: list[AuditRead]


@router.get("", response_model=PaginatedAudit)
async def list_audit(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    action: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission(MANAGE_USERS)),
) -> PaginatedAudit:
    """The user-action audit trail. Restricted to users who can manage users."""
    stmt = select(AuditLog)
    count_stmt = select(func.count()).select_from(AuditLog)
    if action:
        stmt = stmt.where(AuditLog.action == action)
        count_stmt = count_stmt.where(AuditLog.action == action)

    offset = (page - 1) * page_size
    total = await db.scalar(count_stmt) or 0
    rows = list(
        await db.scalars(
            stmt.order_by(AuditLog.created_at.desc()).offset(offset).limit(page_size)
        )
    )
    items = [
        AuditRead(
            id=str(r.id), user_email=r.user_email, action=r.action,
            target_type=r.target_type, target_id=r.target_id,
            detail=r.detail, created_at=r.created_at,
        )
        for r in rows
    ]
    return PaginatedAudit(total=total, items=items)
