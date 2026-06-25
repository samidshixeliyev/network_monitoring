"""device text columns -> NVARCHAR (Unicode) for Azerbaijani text

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-06-25

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("devices", "vendor_name", type_=sa.Unicode(100), existing_nullable=False)
    op.alter_column("devices", "model_name", type_=sa.Unicode(100), existing_nullable=True)
    op.alter_column("devices", "description", type_=sa.UnicodeText(), existing_nullable=True)
    op.alter_column("devices", "location_text", type_=sa.Unicode(255), existing_nullable=True)


def downgrade() -> None:
    op.alter_column("devices", "vendor_name", type_=sa.String(100), existing_nullable=False)
    op.alter_column("devices", "model_name", type_=sa.String(100), existing_nullable=True)
    op.alter_column("devices", "description", type_=sa.Text(), existing_nullable=True)
    op.alter_column("devices", "location_text", type_=sa.String(255), existing_nullable=True)
