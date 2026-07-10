from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, String, Unicode, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DiscoveredDevice(Base):
    """An IP that answered the discovery ping sweep but is not monitored yet.

    Pending inventory: an admin either approves it (a real Device row is created
    and this row is deleted) or ignores it (kept so the sweep doesn't re-propose
    it every cycle)."""

    __tablename__ = "discovered_devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ip_address: Mapped[str] = mapped_column(String(45), unique=True, nullable=False)
    # Best-effort reverse DNS at discovery time.
    hostname: Mapped[str | None] = mapped_column(Unicode(255))
    rtt_ms: Mapped[float | None] = mapped_column(Float)
    # new → awaiting a decision; ignored → hidden from the pending list.
    status: Mapped[str] = mapped_column(
        String(10), default="new", server_default="new", nullable=False
    )
    first_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
