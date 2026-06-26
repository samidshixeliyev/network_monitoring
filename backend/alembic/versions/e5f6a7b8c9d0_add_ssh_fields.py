"""add SSH telemetry fields to devices

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-06-26

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (name, column factory) — added only if not already present (idempotent).
_COLUMNS = [
    ("ssh_enabled", lambda: sa.Column("ssh_enabled", sa.Boolean(), nullable=False, server_default="0")),
    ("ssh_port", lambda: sa.Column("ssh_port", sa.Integer(), nullable=False, server_default="22")),
    ("ssh_username", lambda: sa.Column("ssh_username", sa.Unicode(100), nullable=True)),
    ("ssh_password", lambda: sa.Column("ssh_password", sa.Unicode(255), nullable=True)),
    ("ssh_status", lambda: sa.Column("ssh_status", sa.String(20), nullable=False, server_default="unknown")),
    ("ssh_hostname", lambda: sa.Column("ssh_hostname", sa.Unicode(255), nullable=True)),
    ("ssh_uptime", lambda: sa.Column("ssh_uptime", sa.Unicode(255), nullable=True)),
    ("ssh_facts", lambda: sa.Column("ssh_facts", sa.UnicodeText(), nullable=True)),
    ("ssh_collected_at", lambda: sa.Column("ssh_collected_at", sa.DateTime(timezone=True), nullable=True)),
]


def _column_exists(table: str, column: str) -> bool:
    bind = op.get_bind()
    return bool(
        bind.exec_driver_sql(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS "
            f"WHERE TABLE_NAME = '{table}' AND COLUMN_NAME = '{column}'"
        ).first()
    )


def upgrade() -> None:
    for name, factory in _COLUMNS:
        if not _column_exists("devices", name):
            op.add_column("devices", factory())


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        if _column_exists("devices", name):
            op.drop_column("devices", name)
