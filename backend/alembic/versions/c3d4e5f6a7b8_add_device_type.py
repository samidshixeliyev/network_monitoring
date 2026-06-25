"""add device_type column (map icon per type)

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-06-25

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

device_type_enum = sa.Enum(
    "router", "switch", "server", "firewall", "access_point", "other",
    name="device_type", native_enum=False, length=20,
)


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("device_type", device_type_enum, nullable=False, server_default="other"),
    )
    # Backfill the existing bot devices from their names.
    op.execute("UPDATE devices SET device_type = 'router' WHERE vendor_name LIKE '%Router%'")
    op.execute("UPDATE devices SET device_type = 'switch' WHERE vendor_name LIKE '%Switch%'")


def downgrade() -> None:
    op.drop_column("devices", "device_type")
