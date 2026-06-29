"""initial schema (PostgreSQL + TimescaleDB)

Single clean baseline for the Postgres migration. Replaces the old MSSQL
migration chain (initial + nvarchar + device_type + is_critical + ssh_fields),
which is collapsed here because production runs on a fresh Postgres database.

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Timescale extension lives in the same DB; the hypertable for ping history
    # is created by a later migration. Safe no-op if already present / unavailable.
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE")

    op.create_table(
        "roles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=50), nullable=False),
        sa.UniqueConstraint("name", name="uq_roles_name"),
    )

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("hashed_password", sa.String(length=255), nullable=False),
        sa.Column("role_id", sa.Integer(), sa.ForeignKey("roles.id"), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "devices",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True),
        sa.Column("vendor_name", sa.Unicode(length=100), nullable=False),
        sa.Column("ip_address", sa.String(length=45), nullable=False),
        sa.Column("model_name", sa.Unicode(length=100), nullable=True),
        sa.Column("description", sa.UnicodeText(), nullable=True),
        sa.Column("location_text", sa.Unicode(length=255), nullable=True),
        sa.Column(
            "device_type", sa.String(length=20), nullable=False, server_default="other"
        ),
        sa.Column("latitude", sa.Numeric(9, 6), nullable=True),
        sa.Column("longitude", sa.Numeric(9, 6), nullable=True),
        sa.Column(
            "current_status", sa.String(length=20), nullable=False, server_default="unknown"
        ),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_critical", sa.Boolean(), nullable=False, server_default=sa.false()),
        # ── SSH telemetry ──
        sa.Column("ssh_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("ssh_port", sa.Integer(), nullable=False, server_default="22"),
        sa.Column("ssh_username", sa.Unicode(length=100), nullable=True),
        sa.Column("ssh_password", sa.Unicode(length=255), nullable=True),
        sa.Column("ssh_status", sa.String(length=20), nullable=False, server_default="unknown"),
        sa.Column("ssh_hostname", sa.Unicode(length=255), nullable=True),
        sa.Column("ssh_uptime", sa.Unicode(length=255), nullable=True),
        sa.Column("ssh_facts", sa.UnicodeText(), nullable=True),
        sa.Column("ssh_collected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("ip_address", name="uq_devices_ip_address"),
    )

    op.create_table(
        "event_logs",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True),
        sa.Column(
            "device_id",
            sa.Uuid(as_uuid=True),
            sa.ForeignKey("devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_event_logs_device_id", "event_logs", ["device_id"])
    op.create_index("ix_event_logs_created_at", "event_logs", ["created_at"])


def downgrade() -> None:
    op.drop_table("event_logs")
    op.drop_table("devices")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
    op.drop_table("roles")
