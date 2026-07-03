"""SNMP telemetry: device config/state columns + snmp_history hypertable

Revision ID: 0005_snmp
Revises: 0004_p7_features
Create Date: 2026-07-03
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_snmp"
down_revision: str | None = "0004_p7_features"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("snmp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "devices",
        sa.Column("snmp_port", sa.Integer(), nullable=False, server_default="161"),
    )
    op.add_column("devices", sa.Column("snmp_community", sa.Unicode(length=100), nullable=True))
    op.add_column(
        "devices",
        sa.Column("snmp_version", sa.String(length=5), nullable=False, server_default="2c"),
    )
    op.add_column(
        "devices",
        sa.Column("snmp_status", sa.String(length=20), nullable=False, server_default="unknown"),
    )
    op.add_column("devices", sa.Column("snmp_facts", sa.UnicodeText(), nullable=True))
    op.add_column("devices", sa.Column("snmp_collected_at", sa.DateTime(timezone=True), nullable=True))

    # Device-level metric samples per poll (CPU/mem % + summed interface rates).
    op.create_table(
        "snmp_history",
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("cpu_percent", sa.Float(), nullable=True),
        sa.Column("mem_percent", sa.Float(), nullable=True),
        sa.Column("in_bps", sa.Float(), nullable=True),
        sa.Column("out_bps", sa.Float(), nullable=True),
        sa.PrimaryKeyConstraint("ts", "device_id", name="pk_snmp_history"),
    )
    op.create_index("ix_snmp_history_device_ts", "snmp_history", ["device_id", "ts"])

    # Promote to a hypertable + retention if Timescale is present (same pattern
    # as ping_history in 0003).
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
                PERFORM create_hypertable('snmp_history', 'ts', if_not_exists => TRUE);
                PERFORM add_retention_policy('snmp_history', INTERVAL '90 days', if_not_exists => TRUE);
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.drop_index("ix_snmp_history_device_ts", table_name="snmp_history")
    op.drop_table("snmp_history")
    op.drop_column("devices", "snmp_collected_at")
    op.drop_column("devices", "snmp_facts")
    op.drop_column("devices", "snmp_status")
    op.drop_column("devices", "snmp_version")
    op.drop_column("devices", "snmp_community")
    op.drop_column("devices", "snmp_port")
    op.drop_column("devices", "snmp_enabled")
