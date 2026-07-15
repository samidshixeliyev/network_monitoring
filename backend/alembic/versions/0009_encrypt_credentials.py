"""Encrypt device credentials at rest (SSH password, SNMP community / v3 keys).

Widens the four credential columns to TEXT (Fernet ciphertext is far longer than
the plaintext) and encrypts any existing plaintext values in place. Reads stay
transparent via app.core.crypto.EncryptedString; legacy plaintext (if this
migration is skipped) is still handled at the ORM layer.

Revision ID: 0009_encrypt_credentials
Revises: 0008_snmp_traps
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009_encrypt_credentials"
down_revision: str | None = "0008_snmp_traps"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# column name → previous varchar length (for downgrade)
_COLS: dict[str, int] = {
    "ssh_password": 255,
    "snmp_community": 100,
    "snmp_v3_auth_key": 255,
    "snmp_v3_priv_key": 255,
}


def upgrade() -> None:
    # 1) Widen to TEXT so ciphertext fits.
    for col, length in _COLS.items():
        op.alter_column(
            "devices", col,
            existing_type=sa.Unicode(length=length),
            type_=sa.Text(),
            existing_nullable=True,
        )

    # 2) Encrypt existing plaintext in place (idempotent — skips already-encrypted
    #    values via the enc:: prefix check inside encrypt/is_encrypted).
    from app.core.crypto import encrypt_value, is_encrypted

    conn = op.get_bind()
    cols = list(_COLS)
    rows = conn.execute(
        sa.text(f"SELECT id, {', '.join(cols)} FROM devices")
    ).mappings().all()
    for row in rows:
        updates = {
            col: encrypt_value(row[col])
            for col in cols
            if row[col] and not is_encrypted(row[col])
        }
        if updates:
            set_clause = ", ".join(f"{c} = :{c}" for c in updates)
            conn.execute(
                sa.text(f"UPDATE devices SET {set_clause} WHERE id = :id"),
                {**updates, "id": row["id"]},
            )


def downgrade() -> None:
    # Decrypt back to plaintext, then narrow the columns to their old widths.
    from app.core.crypto import decrypt_value, is_encrypted

    conn = op.get_bind()
    cols = list(_COLS)
    rows = conn.execute(
        sa.text(f"SELECT id, {', '.join(cols)} FROM devices")
    ).mappings().all()
    for row in rows:
        updates = {
            col: decrypt_value(row[col])
            for col in cols
            if row[col] and is_encrypted(row[col])
        }
        if updates:
            set_clause = ", ".join(f"{c} = :{c}" for c in updates)
            conn.execute(
                sa.text(f"UPDATE devices SET {set_clause} WHERE id = :id"),
                {**updates, "id": row["id"]},
            )

    for col, length in _COLS.items():
        op.alter_column(
            "devices", col,
            existing_type=sa.Text(),
            type_=sa.Unicode(length=length),
            existing_nullable=True,
        )
