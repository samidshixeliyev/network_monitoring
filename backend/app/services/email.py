"""Minimal SMTP email sender (stdlib smtplib in a thread executor).

Designed for an internal mail relay on an air-gapped network. Never raises —
returns True/False so the alert engine can log and carry on.
"""
import asyncio
import logging
import smtplib
from email.message import EmailMessage

from app.core.config import settings

logger = logging.getLogger(__name__)


def _recipients() -> list[str]:
    return [a.strip() for a in settings.ALERT_EMAIL_TO.split(",") if a.strip()]


def _send_sync(subject: str, body: str) -> bool:
    to = _recipients()
    if not settings.SMTP_HOST or not to:
        logger.warning("email not sent — SMTP_HOST/ALERT_EMAIL_TO not configured")
        return False
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.SMTP_FROM
    msg["To"] = ", ".join(to)
    msg.set_content(body)
    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as s:
            if settings.SMTP_TLS:
                s.starttls()
            if settings.SMTP_USER:
                s.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            s.send_message(msg)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.error("email send failed: %s", exc)
        return False


async def send_email(subject: str, body: str) -> bool:
    return await asyncio.get_running_loop().run_in_executor(None, _send_sync, subject, body)
