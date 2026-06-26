"""add is_critical flag (priority alerts)

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-06-25

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table: str, column: str) -> bool:
    bind = op.get_bind()
    return bool(
        bind.exec_driver_sql(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS "
            f"WHERE TABLE_NAME = '{table}' AND COLUMN_NAME = '{column}'"
        ).first()
    )


def upgrade() -> None:
    # Idempotent — already present on a fresh DB via the initial_schema rewrite.
    if _column_exists("devices", "is_critical"):
        return
    op.add_column(
        "devices",
        sa.Column("is_critical", sa.Boolean(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("devices", "is_critical")
