"""Priority 7 device columns: topology, maintenance/ack/mute, multi-condition, alerts

Revision ID: 0004_p7_features
Revises: 0003_ping_history
Create Date: 2026-06-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_p7_features"
down_revision: str | None = "0003_ping_history"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("parent_id", sa.Uuid(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_devices_parent_id", "devices", "devices",
        ["parent_id"], ["id"], ondelete="SET NULL",
    )
    op.add_column("devices", sa.Column("maintenance_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "devices",
        sa.Column("is_muted", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("devices", sa.Column("alarm_acked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("devices", sa.Column("alert_notified_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("devices", sa.Column("check_tcp_port", sa.Integer(), nullable=True))
    op.add_column("devices", sa.Column("check_http_url", sa.Unicode(length=500), nullable=True))
    op.add_column("devices", sa.Column("check_http_expect", sa.Integer(), nullable=True))
    op.add_column("devices", sa.Column("service_ok", sa.Boolean(), nullable=True))
    op.add_column("devices", sa.Column("service_detail", sa.Unicode(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "service_detail")
    op.drop_column("devices", "service_ok")
    op.drop_column("devices", "check_http_expect")
    op.drop_column("devices", "check_http_url")
    op.drop_column("devices", "check_tcp_port")
    op.drop_column("devices", "alert_notified_at")
    op.drop_column("devices", "alarm_acked_at")
    op.drop_column("devices", "is_muted")
    op.drop_column("devices", "maintenance_until")
    op.drop_constraint("fk_devices_parent_id", "devices", type_="foreignkey")
    op.drop_column("devices", "parent_id")
