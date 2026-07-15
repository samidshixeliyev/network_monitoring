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

from app.core.crypto import EncryptedString
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
    # Encrypted at rest (Fernet) so DB dumps/backups never expose the password.
    ssh_password: Mapped[str | None] = mapped_column(EncryptedString)
    # Last collection result: unknown | ok | auth_failed | unreachable | error
    ssh_status: Mapped[str] = mapped_column(
        String(20), default="unknown", server_default="unknown", nullable=False
    )
    ssh_hostname: Mapped[str | None] = mapped_column(Unicode(255))
    ssh_uptime: Mapped[str | None] = mapped_column(Unicode(255))
    # JSON blob of additional facts (interfaces, etc.) collected over SSH.
    ssh_facts: Mapped[str | None] = mapped_column(UnicodeText)
    ssh_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # ── SNMP telemetry (optional, per-device) ───────────────────────────────
    # When snmp_enabled, the collector polls the device over SNMP v2c for
    # system info, CPU/memory and per-interface traffic counters. The community
    # string is write-only through the API (like ssh_password).
    snmp_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    snmp_port: Mapped[int] = mapped_column(Integer, default=161, server_default="161", nullable=False)
    # Encrypted at rest (Fernet), like ssh_password.
    snmp_community: Mapped[str | None] = mapped_column(EncryptedString)
    snmp_version: Mapped[str] = mapped_column(
        String(5), default="2c", server_default="2c", nullable=False
    )
    # SNMPv3 (USM) — used when snmp_version == "3". The keys are write-only
    # through the API (like ssh_password / snmp_community).
    snmp_v3_user: Mapped[str | None] = mapped_column(Unicode(100))
    # none | md5 | sha | sha256
    snmp_v3_auth_proto: Mapped[str] = mapped_column(
        String(10), default="sha", server_default="sha", nullable=False
    )
    # Encrypted at rest (Fernet), like ssh_password.
    snmp_v3_auth_key: Mapped[str | None] = mapped_column(EncryptedString)
    # none | des | aes | aes256
    snmp_v3_priv_proto: Mapped[str] = mapped_column(
        String(10), default="aes", server_default="aes", nullable=False
    )
    # Encrypted at rest (Fernet), like ssh_password.
    snmp_v3_priv_key: Mapped[str | None] = mapped_column(EncryptedString)
    # Last collection result: unknown | ok | timeout | error
    snmp_status: Mapped[str] = mapped_column(
        String(20), default="unknown", server_default="unknown", nullable=False
    )
    # JSON blob: sys_name/sys_descr/uptime/cpu_percent/mem_percent/interfaces.
    snmp_facts: Mapped[str | None] = mapped_column(UnicodeText)
    snmp_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # ── Topology / dependency ───────────────────────────────────────────────
    # When the parent is down, this device's alarm is suppressed and shown as
    # "unreachable (parent X down)" — avoids alarm storms during an upstream outage.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL")
    )
    # ── Maintenance / acknowledge / mute ────────────────────────────────────
    # Under maintenance until this time → no alarms (planned work).
    maintenance_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Muted → keep monitoring but suppress alert notifications/sound.
    is_muted: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    # Set when a user acknowledges the current alarm (cleared on recovery).
    alarm_acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Alert engine bookkeeping: when the last down-notification was sent (cleared
    # on recovery) so we don't re-notify every cycle.
    alert_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # ── Multi-condition checks (beyond ICMP) ────────────────────────────────
    # Optional TCP port and/or HTTP URL probe to catch "pings but service dead".
    check_tcp_port: Mapped[int | None] = mapped_column(Integer)
    check_http_url: Mapped[str | None] = mapped_column(Unicode(500))
    check_http_expect: Mapped[int | None] = mapped_column(Integer)
    # Last service-check result: True ok, False failing, None = no check configured.
    service_ok: Mapped[bool | None] = mapped_column(Boolean)
    service_detail: Mapped[str | None] = mapped_column(Unicode(255))

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
