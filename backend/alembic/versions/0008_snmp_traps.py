"""SNMP trap store — hypertable for the UDP SNMP trap receiver.

One row per received SNMPv1/v2c trap (linkDown/linkUp/coldStart/authFailure/…),
matched to a device by source IP. Same TimescaleDB treatment as syslog_history
(30-day retention; created inside the `DO $$ IF timescaledb $$` guard so it is a
no-op on plain Postgres).

Revision ID: 0008_snmp_traps
Revises: 0007_device_links
Create Date: 2026-07-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008_snmp_traps"
down_revision: str | None = "0007_device_links"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "snmp_traps",
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("host", sa.String(length=45), nullable=False),
        sa.Column("device_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("version", sa.String(length=4), server_default="2c", nullable=False),
        sa.Column("trap_oid", sa.String(length=255), nullable=True),
        sa.Column("trap_name", sa.Unicode(length=80), server_default="trap", nullable=False),
        sa.Column("severity", sa.SmallInteger(), server_default="5", nullable=False),
        sa.Column("if_index", sa.Integer(), nullable=True),
        sa.Column("message", sa.UnicodeText(), nullable=False),
        sa.Column("varbinds", sa.UnicodeText(), nullable=True),
        sa.PrimaryKeyConstraint("ts", "id", name="pk_snmp_traps"),
    )
    op.create_index("ix_snmp_traps_host", "snmp_traps", ["host", "ts"])
    op.create_index("ix_snmp_traps_device_id", "snmp_traps", ["device_id", "ts"])
    op.create_index("ix_snmp_traps_severity", "snmp_traps", ["severity", "ts"])
    op.create_index("ix_snmp_traps_trap_oid", "snmp_traps", ["trap_oid"])

    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
                PERFORM create_hypertable('snmp_traps', 'ts', if_not_exists => TRUE);
                PERFORM add_retention_policy('snmp_traps', INTERVAL '30 days', if_not_exists => TRUE);
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.drop_index("ix_snmp_traps_trap_oid", table_name="snmp_traps")
    op.drop_index("ix_snmp_traps_severity", table_name="snmp_traps")
    op.drop_index("ix_snmp_traps_device_id", table_name="snmp_traps")
    op.drop_index("ix_snmp_traps_host", table_name="snmp_traps")
    op.drop_table("snmp_traps")
