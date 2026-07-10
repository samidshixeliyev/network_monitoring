#!/usr/bin/env python3
"""External watchdog for the monitoring server — "who monitors the monitor".

Run this on a DIFFERENT machine (a second server, a Raspberry Pi, an existing
jump host). It polls the monitor's unauthenticated /healthz endpoint and raises
an alarm when:

  * the API stops answering (monitor host/container down), or
  * the API answers but the collector heartbeat is stale (probing stuck).

Alerts go out over any combination of SMTP, webhook, and a local command
(e.g. gammu-smsd-inject for SMS via a GSM modem) — configured with environment
variables so the script itself needs nothing beyond the Python 3 stdlib.

    WATCHDOG_URL=http://monitor:8000/healthz     # required
    WATCHDOG_INTERVAL=60                         # seconds between checks
    WATCHDOG_FAILURES=3                          # consecutive failures before alarm

    WATCHDOG_SMTP_HOST=  WATCHDOG_SMTP_PORT=25  WATCHDOG_SMTP_FROM=watchdog@example.com
    WATCHDOG_SMTP_USER=  WATCHDOG_SMTP_PASSWORD=  WATCHDOG_SMTP_TLS=false
    WATCHDOG_EMAIL_TO=noc@example.com,oncall@example.com

    WATCHDOG_WEBHOOK_URL=                        # POST {"subject","body","text"} JSON

    WATCHDOG_COMMAND=                            # e.g. gammu-smsd-inject TEXT {to} -text {text}
    WATCHDOG_COMMAND_TO=+994501234567,+99450...

Example systemd unit (put env vars in /etc/netmon-watchdog.env):

    [Unit]
    Description=NetMonitor external watchdog
    After=network-online.target

    [Service]
    EnvironmentFile=/etc/netmon-watchdog.env
    ExecStart=/usr/bin/python3 /opt/netmon/watchdog.py
    Restart=always
    RestartSec=10

    [Install]
    WantedBy=multi-user.target
"""
import json
import logging
import os
import shlex
import smtplib
import subprocess
import time
import urllib.request
from email.message import EmailMessage

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("watchdog")

URL = os.environ.get("WATCHDOG_URL", "")
INTERVAL = int(os.environ.get("WATCHDOG_INTERVAL", "60"))
FAILURES = int(os.environ.get("WATCHDOG_FAILURES", "3"))
HTTP_TIMEOUT = 15


def check() -> tuple[bool, str]:
    """→ (healthy, detail)."""
    try:
        with urllib.request.urlopen(URL, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001
        return False, f"API unreachable: {exc}"
    if not data.get("collector_healthy"):
        age = data.get("heartbeat_age_seconds")
        return False, f"API up but collector heartbeat is stale (age={age}s)"
    return True, "ok"


# ── Alert channels (all optional; every configured one is attempted) ──────────
def _send_email(subject: str, body: str) -> None:
    host = os.environ.get("WATCHDOG_SMTP_HOST")
    to = [a.strip() for a in os.environ.get("WATCHDOG_EMAIL_TO", "").split(",") if a.strip()]
    if not host or not to:
        return
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("WATCHDOG_SMTP_FROM", "watchdog@example.com")
    msg["To"] = ", ".join(to)
    msg.set_content(body)
    try:
        with smtplib.SMTP(host, int(os.environ.get("WATCHDOG_SMTP_PORT", "25")), timeout=15) as s:
            if os.environ.get("WATCHDOG_SMTP_TLS", "false").lower() == "true":
                s.starttls()
            user = os.environ.get("WATCHDOG_SMTP_USER")
            if user:
                s.login(user, os.environ.get("WATCHDOG_SMTP_PASSWORD", ""))
            s.send_message(msg)
        log.info("email sent to %s", msg["To"])
    except Exception as exc:  # noqa: BLE001
        log.error("email failed: %s", exc)


def _send_webhook(subject: str, body: str) -> None:
    url = os.environ.get("WATCHDOG_WEBHOOK_URL")
    if not url:
        return
    payload = json.dumps({"subject": subject, "body": body, "text": f"{subject}\n{body}"}).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=HTTP_TIMEOUT)
        log.info("webhook sent")
    except Exception as exc:  # noqa: BLE001
        log.error("webhook failed: %s", exc)


def _send_command(subject: str) -> None:
    template = os.environ.get("WATCHDOG_COMMAND")
    if not template:
        return
    numbers = [n.strip() for n in os.environ.get("WATCHDOG_COMMAND_TO", "").split(",") if n.strip()] or [""]
    for number in numbers:
        argv = [p.replace("{to}", number).replace("{text}", subject) for p in shlex.split(template)]
        try:
            subprocess.run(argv, timeout=30, check=True, capture_output=True)
            log.info("command run for %r", number or "(no {to})")
        except Exception as exc:  # noqa: BLE001
            log.error("command failed: %s", exc)


def alert(subject: str, body: str) -> None:
    log.warning("ALERT: %s — %s", subject, body.replace("\n", " | "))
    _send_email(subject, body)
    _send_webhook(subject, body)
    _send_command(subject)


def main() -> None:
    if not URL:
        raise SystemExit("WATCHDOG_URL is required, e.g. http://monitor:8000/healthz")
    log.info("watching %s every %ds (alarm after %d consecutive failures)", URL, INTERVAL, FAILURES)

    consecutive = 0
    alarmed = False
    while True:
        healthy, detail = check()
        if healthy:
            if alarmed:
                alert("[RESOLVED] monitoring server is healthy again", f"URL: {URL}\nStatus: {detail}\n")
                alarmed = False
            if consecutive:
                log.info("recovered after %d failed checks", consecutive)
            consecutive = 0
        else:
            consecutive += 1
            log.warning("check failed (%d/%d): %s", consecutive, FAILURES, detail)
            if consecutive >= FAILURES and not alarmed:
                alert(
                    "[ALERT] monitoring server is DOWN or stuck",
                    f"URL: {URL}\nProblem: {detail}\n"
                    f"Failed checks: {consecutive} (every {INTERVAL}s)\n"
                    "The network is currently UNMONITORED — investigate the monitor host.\n",
                )
                alarmed = True
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
