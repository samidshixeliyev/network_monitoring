"""Transparent at-rest encryption for sensitive device credentials.

Device SSH passwords and SNMP community / v3 keys are stored ENCRYPTED so a DB
dump or backup never leaks them in plaintext. Encryption is transparent to the
ORM through the `EncryptedString` TypeDecorator: values are Fernet-encrypted on
write and decrypted on read.

Migration-friendly: legacy rows written before encryption was enabled (no
`enc::` prefix) are returned as-is on read and get encrypted on their next
write, so nothing breaks when the feature is switched on.

Key source: `CREDENTIAL_ENCRYPTION_KEY` (a urlsafe-base64 Fernet key) when set;
otherwise it is derived deterministically from `SECRET_KEY` so the feature works
out of the box. NOTE: rotating `SECRET_KEY` WITHOUT an explicit
`CREDENTIAL_ENCRYPTION_KEY` makes previously-encrypted credentials unreadable —
set an explicit key in production before rotating secrets.
"""
import base64
import hashlib
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

from app.core.config import settings

logger = logging.getLogger(__name__)

# Marks a value as ciphertext so plaintext legacy rows are distinguishable.
_TOKEN_PREFIX = "enc::"


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    """Build the Fernet cipher once, from the configured key or a stable key
    derived from SECRET_KEY (sha256 → 32 bytes → urlsafe base64)."""
    key = settings.CREDENTIAL_ENCRYPTION_KEY
    if not key:
        digest = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
        key = base64.urlsafe_b64encode(digest).decode()
    return Fernet(key)


def is_encrypted(value: str) -> bool:
    """True if `value` is one of our ciphertext tokens (has the enc:: prefix)."""
    return value.startswith(_TOKEN_PREFIX)


def encrypt_value(plaintext: str) -> str:
    """Encrypt a plaintext credential into a prefixed Fernet token."""
    return _TOKEN_PREFIX + _fernet().encrypt(plaintext.encode()).decode()


def decrypt_value(value: str) -> str:
    """Decrypt a token back to plaintext. Legacy (unprefixed) or undecryptable
    values are returned unchanged so old rows keep working."""
    if not is_encrypted(value):
        return value  # legacy plaintext row
    try:
        return _fernet().decrypt(value[len(_TOKEN_PREFIX):].encode()).decode()
    except InvalidToken:
        logger.warning("could not decrypt a credential column — returning raw value")
        return value


class EncryptedString(TypeDecorator):
    """A text column whose value is Fernet-encrypted at rest. Reads transparently
    decrypt; legacy plaintext is passed through. Backed by TEXT because Fernet
    tokens are far longer than the plaintext they replace."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect: object) -> str | None:
        if value is None:
            return None
        return encrypt_value(str(value))

    def process_result_value(self, value: str | None, dialect: object) -> str | None:
        if value is None:
            return None
        return decrypt_value(value)
