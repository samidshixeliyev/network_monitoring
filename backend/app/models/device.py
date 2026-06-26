from __future__ import annotations

import enum
import uuid
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Unicode,
    UnicodeText,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.event_log import EventLog
    from app.models.user import User


class DeviceStatus(str, enum.Enum):
    online = "online"
    offline = "offline"
    unknown = "unknown"


class DeviceType(str, enum.Enum):
    router = "router"
    switch = "switch"
    server = "server"
    firewall = "firewall"
    access_point = "access_point"
    other = "other"


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Unicode/UnicodeText → NVARCHAR on MSSQL so Azerbaijani text (ə, ş, ç…)
    # stores correctly; plain VARCHAR loses chars outside the DB code page.
    vendor_name: Mapped[str] = mapped_column(Unicode(100), nullable=False)
    # IP/hostname resolved to an IP string. ASCII only → plain VARCHAR(45)
    # holds the longest possible IPv6 address.
    ip_address: Mapped[str] = mapped_column(String(45), unique=True, nullable=False)
    model_name: Mapped[str | None] = mapped_column(Unicode(100))
    description: Mapped[str | None] = mapped_column(UnicodeText)
    location_text: Mapped[str | None] = mapped_column(Unicode(255))
    # Drives the map icon (router/switch/server/…). VARCHAR + CHECK (portable).
    device_type: Mapped[DeviceType] = mapped_column(
        SAEnum(DeviceType, name="device_type", native_enum=False, length=20),
        default=DeviceType.other,
        server_default=DeviceType.other.value,
        nullable=False,
    )
    # Phase-2 map fields — present now so no migration is needed later
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    # native_enum=False → portable VARCHAR + CHECK constraint (MSSQL has no
    # native ENUM type).
    current_status: Mapped[DeviceStatus] = mapped_column(
        SAEnum(DeviceStatus, name="device_status", native_enum=False, length=20),
        default=DeviceStatus.unknown,
        server_default=DeviceStatus.unknown.value,
        nullable=False,
    )
    # Used by the anti-flap logic in ping_scheduler
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Critical/important device → distinct, higher-priority alert on the frontend.
    is_critical: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0", nullable=False
    )
    # ── SSH telemetry (optional, per-device) ────────────────────────────────
    # When ssh_enabled, a background collector logs in over SSH and pulls a few
    # facts (hostname/uptime/interfaces) — richer than ICMP up/down. Credentials
    # are stored for the lab; in production prefer a secrets store / SSH keys.
    ssh_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0", nullable=False
    )
    ssh_port: Mapped[int] = mapped_column(Integer, default=22, server_default="22", nullable=False)
    ssh_username: Mapped[str | None] = mapped_column(Unicode(100))
    ssh_password: Mapped[str | None] = mapped_column(Unicode(255))
    # Last collection result: unknown | ok | auth_failed | unreachable | error
    ssh_status: Mapped[str] = mapped_column(
        String(20), default="unknown", server_default="unknown", nullable=False
    )
    ssh_hostname: Mapped[str | None] = mapped_column(Unicode(255))
    ssh_uptime: Mapped[str | None] = mapped_column(Unicode(255))
    # JSON blob of additional facts (interfaces, etc.) collected over SSH.
    ssh_facts: Mapped[str | None] = mapped_column(UnicodeText)
    ssh_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    created_by_user: Mapped[User] = relationship(back_populates="devices")
    event_logs: Mapped[list[EventLog]] = relationship(
        back_populates="device", cascade="all, delete-orphan"
    )
