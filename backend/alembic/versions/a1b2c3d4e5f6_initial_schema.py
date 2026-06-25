"""initial schema (MSSQL)

Revision ID: a1b2c3d4e5f6
Revises:
Create Date: 2026-06-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# native_enum=False → rendered as VARCHAR + CHECK constraint (portable, MSSQL has
# no native ENUM type). No CREATE/DROP TYPE needed.
device_status_enum = sa.Enum(
    "online", "offline", "unknown", name="device_status", native_enum=False, length=20
)
device_type_enum = sa.Enum(
    "router", "switch", "server", "firewall", "access_point", "other",
    name="device_type", native_enum=False, length=20,
)
event_type_enum = sa.Enum(
    "came_online", "went_offline", name="event_type", native_enum=False, length=20
)

# DateTime(timezone=True) maps to DATETIMEOFFSET on MSSQL; SYSDATETIMEOFFSET()
# is the offset-aware "now".
NOW = sa.text("SYSDATETIMEOFFSET()")


def upgrade() -> None:
    # ── roles ──────────────────────────────────────────────────────────────────
    op.create_table(
        "roles",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("name", sa.String(50), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )

    # ── users ──────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    # ── devices ────────────────────────────────────────────────────────────────
    op.create_table(
        "devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        # Unicode/UnicodeText → NVARCHAR on MSSQL (Azerbaijani text safe).
        sa.Column("vendor_name", sa.Unicode(100), nullable=False),
        sa.Column("ip_address", sa.String(45), nullable=False),
        sa.Column("model_name", sa.Unicode(100), nullable=True),
        sa.Column("description", sa.UnicodeText(), nullable=True),
        sa.Column("location_text", sa.Unicode(255), nullable=True),
        sa.Column("device_type", device_type_enum, nullable=False, server_default="other"),
        sa.Column("latitude", sa.Numeric(9, 6), nullable=True),
        sa.Column("longitude", sa.Numeric(9, 6), nullable=True),
        sa.Column(
            "current_status", device_status_enum, nullable=False, server_default="unknown"
        ),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("is_critical", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ip_address", name="uq_devices_ip_address"),
    )

    # ── event_logs ─────────────────────────────────────────────────────────────
    op.create_table(
        "event_logs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("event_type", event_type_enum, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_logs_device_id", "event_logs", ["device_id"])
    op.create_index("ix_event_logs_created_at", "event_logs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_event_logs_created_at", table_name="event_logs")
    op.drop_index("ix_event_logs_device_id", table_name="event_logs")
    op.drop_table("event_logs")

    op.drop_table("devices")

    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")

    op.drop_table("roles")
