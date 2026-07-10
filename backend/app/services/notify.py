"""Multi-channel alert delivery: email + webhook + Telegram + SMS command.

A channel is active when its settings are non-empty; every active channel is
attempted for every notification and one failing never blocks the others.
Everything is stdlib (urllib in a thread executor, subprocess for SMS) so the
air-gapped deployment needs no extra packages. Never raises — returns a
{channel: ok} map so callers can log delivery per channel.
"""
import asyncio
import json
import logging
import shlex
import urllib.request

from app.core.config import settings
from app.services.email import send_email

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = 15


def _post_json_sync(url: str, payload: dict) -> bool:
    data = json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001
        logger.error("webhook POST to %s failed: %s", url.split("?")[0], exc)
        return False


async def _post_json(url: str, payload: dict) -> bool:
    return await asyncio.get_running_loop().run_in_executor(None, _post_json_sync, url, payload)


async def _send_webhook(subject: str, body: str, meta: dict) -> bool:
    # "text" makes the same payload work as a Slack/Mattermost incoming webhook.
    return await _post_json(
        settings.ALERT_WEBHOOK_URL,
        {"subject": subject, "body": body, "text": f"{subject}\n{body}", **meta},
    )


async def _send_telegram(subject: str, body: str) -> bool:
    url = f"https://api.telegram.org/bot{settings.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage"
    return await _post_json(
        url, {"chat_id": settings.ALERT_TELEGRAM_CHAT_ID, "text": f"{subject}\n{body}"}
    )


def _sms_numbers() -> list[str]:
    return [n.strip() for n in settings.ALERT_SMS_TO.split(",") if n.strip()]


async def _send_sms(subject: str) -> bool:
    """Run ALERT_SMS_COMMAND once per number, substituting {to} and {text}.
    SMS bodies are tiny — only the subject line is sent."""
    ok = True
    for number in _sms_numbers():
        argv = [
            part.replace("{to}", number).replace("{text}", subject)
            for part in shlex.split(settings.ALERT_SMS_COMMAND)
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            if proc.returncode != 0:
                logger.error("sms command exited %s: %s", proc.returncode, stderr.decode(errors="replace")[:200])
                ok = False
        except Exception as exc:  # noqa: BLE001
            logger.error("sms command failed for %s: %s", number, exc)
            ok = False
    return ok


def active_channels() -> list[str]:
    channels = []
    if settings.SMTP_HOST and settings.ALERT_EMAIL_TO:
        channels.append("email")
    if settings.ALERT_WEBHOOK_URL:
        channels.append("webhook")
    if settings.ALERT_TELEGRAM_BOT_TOKEN and settings.ALERT_TELEGRAM_CHAT_ID:
        channels.append("telegram")
    if settings.ALERT_SMS_COMMAND and _sms_numbers():
        channels.append("sms")
    return channels


async def send_alert(subject: str, body: str, **meta: str) -> dict[str, bool]:
    """Deliver on every configured channel concurrently. Returns {channel: ok};
    empty dict means no channel is configured (worth surfacing in the audit)."""
    tasks: dict[str, asyncio.Task] = {}
    channels = active_channels()
    if "email" in channels:
        tasks["email"] = asyncio.create_task(send_email(subject, body))
    if "webhook" in channels:
        tasks["webhook"] = asyncio.create_task(_send_webhook(subject, body, dict(meta)))
    if "telegram" in channels:
        tasks["telegram"] = asyncio.create_task(_send_telegram(subject, body))
    if "sms" in channels:
        tasks["sms"] = asyncio.create_task(_send_sms(subject))

    if not tasks:
        logger.warning("alert not delivered — no notification channel configured")
        return {}

    results: dict[str, bool] = {}
    for name, task in tasks.items():
        try:
            results[name] = bool(await task)
        except Exception as exc:  # noqa: BLE001 — belt and braces; channels shouldn't raise
            logger.error("alert channel %s raised: %s", name, exc)
            results[name] = False
    return results


def summarize(results: dict[str, bool]) -> str:
    """'email ok, sms failed' — for audit rows / logs."""
    if not results:
        return "no channels configured"
    return ", ".join(f"{k} {'ok' if v else 'failed'}" for k, v in results.items())
