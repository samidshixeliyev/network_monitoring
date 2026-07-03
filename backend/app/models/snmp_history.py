from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SnmpHistory(Base):
    """One row per SNMP poll — device-level metrics backing the SNMP charts.

    CPU/memory are percentages; in/out_bps are the summed interface rates
    computed from counter deltas between polls. Same TimescaleDB hypertable
    treatment as ping_history (partitioned on `ts`, 90-day retention, no FK)."""

    __tablename__ = "snmp_history"

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    cpu_percent: Mapped[float | None] = mapped_column(Float)
    mem_percent: Mapped[float | None] = mapped_column(Float)
    in_bps: Mapped[float | None] = mapped_column(Float)
    out_bps: Mapped[float | None] = mapped_column(Float)
