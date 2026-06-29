from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AuditLog(Base):
    """Who did what, when. Separate from EventLog (device up/down): this records
    USER actions — SSH sessions, acks/mutes, device edits, config changes — for
    accountability. user_email is denormalized so the trail survives user deletion."""

    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Nullable: some actions are performed by the system (no user).
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), index=True)
    user_email: Mapped[str | None] = mapped_column(String(255))
    # e.g. ssh.open, device.create, device.update, device.delete, device.simulate
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_type: Mapped[str | None] = mapped_column(String(32))   # e.g. "device"
    target_id: Mapped[str | None] = mapped_column(String(64))      # e.g. device UUID
    detail: Mapped[str | None] = mapped_column(String(1000))       # short free text / JSON
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
