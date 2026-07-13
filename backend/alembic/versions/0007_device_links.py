"""Manual device-to-device links (physical / logical topology mapping).

Operators draw these in the graph view to document real cabling / overlay
adjacency, independent of the single-parent monitoring dependency (parent_id).

Revision ID: 0007_device_links
Revises: 0006_audit_gaps
Create Date: 2026-07-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_device_links"
down_revision: str | None = "0006_audit_gaps"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "device_links",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("source_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("target_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=10), server_default="physical", nullable=False),
        sa.Column("label", sa.String(length=80), nullable=True),
        sa.Column("created_by", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["source_id"], ["devices.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_id"], ["devices.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_id", "target_id", "kind", name="uq_device_links_edge"),
    )
    op.create_index("ix_device_links_source", "device_links", ["source_id"])
    op.create_index("ix_device_links_target", "device_links", ["target_id"])


def downgrade() -> None:
    op.drop_index("ix_device_links_target", table_name="device_links")
    op.drop_index("ix_device_links_source", table_name="device_links")
    op.drop_table("device_links")
