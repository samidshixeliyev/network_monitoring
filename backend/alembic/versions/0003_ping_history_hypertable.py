"""ping_history TimescaleDB hypertable

Time-series store for ping latency/uptime. Created as a Timescale hypertable
(partitioned on ts) with a 90-day retention policy. Falls back to a plain table
if the timescaledb extension isn't available, so the app still runs on vanilla
Postgres (just without automatic partitioning/retention).

Revision ID: 0003_ping_history
Revises: 0002_rbac_audit
Create Date: 2026-06-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_ping_history"
down_revision: str | None = "0002_rbac_audit"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ping_history",
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("rtt_ms", sa.Float(), nullable=True),
        sa.PrimaryKeyConstraint("ts", "device_id", name="pk_ping_history"),
    )
    op.create_index(
        "ix_ping_history_device_ts", "ping_history", ["device_id", "ts"]
    )

    # Promote to a hypertable + retention if Timescale is present. Wrapped in a
    # DO block so a missing extension doesn't fail the migration.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
                PERFORM create_hypertable('ping_history', 'ts', if_not_exists => TRUE);
                PERFORM add_retention_policy('ping_history', INTERVAL '90 days', if_not_exists => TRUE);
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.drop_index("ix_ping_history_device_ts", table_name="ping_history")
    op.drop_table("ping_history")
