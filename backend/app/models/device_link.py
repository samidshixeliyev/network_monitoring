from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DeviceLink(Base):
    """A manually-drawn connection between two devices in the network map.

    Distinct from Device.parent_id (which is a single monitoring *dependency*
    used to suppress downstream alarms): a device can have many links, each
    tagged as a physical cabling run or a logical/overlay adjacency. Operators
    draw these in the graph view to document the real topology so faults are
    easier to reason about later.
    """

    __tablename__ = "device_links"
    __table_args__ = (
        UniqueConstraint("source_id", "target_id", "kind", name="uq_device_links_edge"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    target_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    # "physical" (cabling) or "logical" (VLAN / tunnel / routing adjacency).
    kind: Mapped[str] = mapped_column(
        String(10), default="physical", server_default="physical", nullable=False
    )
    label: Mapped[str | None] = mapped_column(String(80))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
