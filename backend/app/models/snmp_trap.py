from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, SmallInteger, String, Unicode, UnicodeText, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SnmpTrap(Base):
    """One row per received SNMP trap (SNMPv1 / SNMPv2c over UDP).

    Same TimescaleDB hypertable treatment as syslog_history: partitioned on `ts`,
    30-day retention, no FK to devices (device_id is a best-effort match of the
    packet's source IP at ingest time, kept even if the device is later removed).
    Composite PK (ts, id) includes the partition column, as Timescale requires."""

    __tablename__ = "snmp_traps"

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Packet source address — the device identity even when no Device row matches.
    host: Mapped[str] = mapped_column(String(45), nullable=False, index=True)
    device_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), index=True)
    # "1" or "2c".
    version: Mapped[str] = mapped_column(String(4), nullable=False, server_default="2c")
    # snmpTrapOID.0 value (numeric), e.g. 1.3.6.1.6.3.1.1.5.3 for linkDown.
    trap_oid: Mapped[str | None] = mapped_column(String(255), index=True)
    # Friendly name: linkDown / linkUp / coldStart / authenticationFailure / …
    trap_name: Mapped[str] = mapped_column(Unicode(80), nullable=False, server_default="trap")
    # 0=emerg … 7=debug (same scale as syslog, for a unified severity filter).
    severity: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="5", index=True)
    # ifIndex parsed from the trap varbinds, when it's a link up/down. Full 32-bit
    # Integer: real chassis/NX-OS/Junos ifIndexes routinely exceed a signed smallint
    # (32767), which would otherwise abort the whole trap flush batch.
    if_index: Mapped[int | None] = mapped_column(Integer)
    # Human summary + the full varbind list as JSON text.
    message: Mapped[str] = mapped_column(UnicodeText, nullable=False)
    varbinds: Mapped[str | None] = mapped_column(UnicodeText)
