from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, SmallInteger, String, Unicode, UnicodeText, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SyslogMessage(Base):
    """One row per received syslog datagram (RFC3164/RFC5424 over UDP).

    Same TimescaleDB hypertable treatment as ping_history: partitioned on `ts`,
    30-day retention, no FK to devices (device_id is a best-effort match of the
    packet's source IP at ingest time, kept even if the device is later removed).
    Composite PK (ts, id) includes the partition column, as Timescale requires."""

    __tablename__ = "syslog_history"

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Packet source address — the device identity even when no Device row matches.
    host: Mapped[str] = mapped_column(String(45), nullable=False, index=True)
    device_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), index=True)
    facility: Mapped[int | None] = mapped_column(SmallInteger)
    # 0=emerg … 7=debug (RFC5424 table 2).
    severity: Mapped[int] = mapped_column(SmallInteger, nullable=False, index=True)
    app_name: Mapped[str | None] = mapped_column(Unicode(100))
    message: Mapped[str] = mapped_column(UnicodeText, nullable=False)
