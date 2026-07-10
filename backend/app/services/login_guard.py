"""Login brute-force guard — per-IP sliding window, in memory.

Lives in the API process (login handling is there, not in the collector).
After LOGIN_MAX_FAILURES failed logins from one IP within LOGIN_WINDOW_SECONDS,
further attempts from that IP are rejected with 429 until the window drains,
and an alert goes out on the configured channels (once per window per IP).

In-memory is a deliberate trade-off: with several API gateway replicas each
counts separately, so the effective threshold is N× — still plenty to stop a
dictionary attack, with zero shared state to operate.
"""
import logging
import time
from collections import defaultdict, deque

from app.core.config import settings
from app.services import notify
from app.services.audit import record_audit_safe

logger = logging.getLogger(__name__)

_failures: dict[str, deque[float]] = defaultdict(deque)
_alerted_at: dict[str, float] = {}


def _enabled() -> bool:
    return settings.LOGIN_MAX_FAILURES > 0 and settings.LOGIN_WINDOW_SECONDS > 0


def _prune(ip: str, now: float) -> deque[float]:
    q = _failures[ip]
    while q and now - q[0] > settings.LOGIN_WINDOW_SECONDS:
        q.popleft()
    if not q:
        _failures.pop(ip, None)
    return q


def is_blocked(ip: str) -> bool:
    """True → the IP has already burned through its attempts for this window."""
    if not _enabled():
        return False
    return len(_prune(ip, time.monotonic())) >= settings.LOGIN_MAX_FAILURES


async def register_failure(ip: str, email: str) -> None:
    """Record a failed login; on crossing the threshold, audit + alert."""
    await record_audit_safe(
        None, "auth.login_failed", target_type="ip", target_id=ip, detail=email[:100]
    )
    if not _enabled():
        return
    now = time.monotonic()
    q = _prune(ip, now)
    q.append(now)
    _failures[ip] = q

    if len(q) < settings.LOGIN_MAX_FAILURES:
        return
    last = _alerted_at.get(ip)
    if last and now - last < settings.LOGIN_WINDOW_SECONDS:
        return
    _alerted_at[ip] = now

    logger.warning("login brute-force threshold hit from %s (last email tried: %s)", ip, email)
    await record_audit_safe(
        None, "auth.bruteforce_detected", target_type="ip", target_id=ip,
        detail=f"{len(q)} failures in {settings.LOGIN_WINDOW_SECONDS}s",
    )
    results = await notify.send_alert(
        f"[SECURITY] Login brute-force from {ip}",
        f"IP: {ip}\nFailed attempts: {len(q)} within {settings.LOGIN_WINDOW_SECONDS}s\n"
        f"Last email tried: {email[:100]}\n"
        f"Further attempts from this IP now receive 429 until the window drains.\n",
        kind="security", device_ip=ip,
    )
    logger.warning("brute-force alert: %s", notify.summarize(results))


def register_success(ip: str) -> None:
    """A successful login clears the IP's failure history."""
    _failures.pop(ip, None)
    _alerted_at.pop(ip, None)
