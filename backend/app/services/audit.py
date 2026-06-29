"""Audit trail helper — records WHO did WHAT for accountability.

Kept deliberately simple: one row per user action. Used by the SSH bridge,
device CRUD, simulate, and ack/mute. Failures here must never break the action
itself, so callers that can't tolerate a rollback should use record_audit_safe.
"""
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import AsyncSessionLocal
from app.models import AuditLog, User

logger = logging.getLogger(__name__)


def add_audit(
    session: AsyncSession,
    user: User | None,
    action: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    detail: str | None = None,
) -> None:
    """Add an audit row to an existing session (committed by the caller)."""
    session.add(
        AuditLog(
            user_id=user.id if user else None,
            user_email=user.email if user else None,
            action=action,
            target_type=target_type,
            target_id=target_id,
            detail=detail,
        )
    )


async def record_audit_safe(
    user: User | None,
    action: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    detail: str | None = None,
) -> None:
    """Record an audit row in its OWN session/commit. Never raises — used from
    places (e.g. the WS shell bridge) where the audit must not affect the flow."""
    try:
        async with AsyncSessionLocal() as session:
            add_audit(
                session, user, action,
                target_type=target_type, target_id=target_id, detail=detail,
            )
            await session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit record failed (%s): %s", action, exc)
