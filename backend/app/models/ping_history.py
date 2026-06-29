from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PingHistory(Base):
    """One row per probe — the time-series backing latency/uptime charts.

    Stored in a TimescaleDB hypertable (partitioned on `ts`) for high-frequency
    writes + fast time-range queries. No FK to devices (kept lean; old rows are
    dropped by the retention policy). Composite PK (ts, device_id) includes the
    partition column, as Timescale requires."""

    __tablename__ = "ping_history"

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    rtt_ms: Mapped[float | None] = mapped_column(Float)
