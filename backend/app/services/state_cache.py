"""
Redis-backed current-state cache + pub/sub bus.

Why this exists (scalability backbone):
  * **Snapshot cache** — the full device list (metadata + live status) is kept in
    a Redis hash so the dashboard's initial load is served FROM REDIS, not from
    Postgres. 100 simultaneous logins therefore do not hammer the database.
  * **Pub/sub bus** — the single collector publishes every status change to a
    Redis channel; each API/WS gateway subscribes ONCE and fans the change out
    to its local WebSocket clients. This decouples probing from serving users
    and lets multiple stateless gateways run behind a load balancer.
  * **Restart-survival** — the cache lives in Redis, so an API restart re-reads
    the snapshot instead of showing a blank map. If the cache is cold (empty),
    it is warmed from Postgres on first read.

Keys:
  devices:full   (hash)  device_id -> JSON of DeviceRead   (the snapshot)
  status:changes (channel)         JSON {device_id,status,last_checked_at}
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

import redis.asyncio as redis
from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from app.core.config import settings

logger = logging.getLogger(__name__)

DEVICES_KEY = "devices:full"
CHANGES_CHANNEL = "status:changes"
HEARTBEAT_KEY = "collector:heartbeat"

_redis: redis.Redis | None = None


def get_redis() -> redis.Redis:
    """Lazy singleton Redis client (decoded str responses).

    Configured to survive idle-connection drops ("Connection reset by peer"):
    periodic health checks detect dead sockets and connection/timeout errors are
    retried with backoff instead of bubbling a 500 up to the dashboard."""
    global _redis
    if _redis is None:
        _redis = redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            health_check_interval=30,
            socket_keepalive=True,
            socket_connect_timeout=5,
            retry=Retry(ExponentialBackoff(cap=1.0, base=0.05), retries=3),
            retry_on_error=[RedisConnectionError, RedisTimeoutError],
        )
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


# ── Snapshot cache (devices:full) ────────────────────────────────────────────
async def warm_devices(serialized: list[dict[str, Any]]) -> None:
    """Replace the whole snapshot hash with the given serialized devices.
    Called on startup to seed the cache from Postgres."""
    r = get_redis()
    pipe = r.pipeline()
    pipe.delete(DEVICES_KEY)
    if serialized:
        pipe.hset(DEVICES_KEY, mapping={d["id"]: json.dumps(d) for d in serialized})
    await pipe.execute()
    logger.info("device snapshot cache warmed with %d device(s)", len(serialized))


async def get_all_devices() -> list[dict[str, Any]]:
    """Return all cached devices (sorted by created_at). Empty list if cold."""
    r = get_redis()
    raw = await r.hgetall(DEVICES_KEY)
    devices = [json.loads(v) for v in raw.values()]
    devices.sort(key=lambda d: d.get("created_at") or "")
    return devices


async def upsert_device(serialized: dict[str, Any]) -> None:
    """Add/replace one device in the snapshot cache (on create/update)."""
    r = get_redis()
    await r.hset(DEVICES_KEY, serialized["id"], json.dumps(serialized))


async def remove_device(device_id: Any) -> None:
    r = get_redis()
    await r.hdel(DEVICES_KEY, str(device_id))


# ── Pub/sub bus (status:changes) ─────────────────────────────────────────────
async def publish_status_change(
    device_id: Any, status: str, last_checked_at: datetime | None
) -> None:
    """Publish a single status change to all subscribed gateways."""
    payload = json.dumps(
        {
            "device_id": str(device_id),
            "status": status,
            "last_checked_at": last_checked_at.isoformat() if last_checked_at else None,
        }
    )
    await get_redis().publish(CHANGES_CHANNEL, payload)


async def update_and_publish(
    serialized: dict[str, Any], status: str, last_checked_at: datetime | None
) -> None:
    """Status changed: refresh the snapshot entry AND publish the delta. Used by
    the collector / simulate path so cache and subscribers stay consistent."""
    await upsert_device(serialized)
    await publish_status_change(serialized["id"], status, last_checked_at)


# ── Collector heartbeat (self-monitoring) ────────────────────────────────────
async def set_heartbeat(iso_timestamp: str) -> None:
    """The collector stamps this every probe cycle so the UI can tell 'all
    healthy' from 'the monitor itself is stuck'."""
    await get_redis().set(HEARTBEAT_KEY, iso_timestamp)


async def get_heartbeat() -> str | None:
    return await get_redis().get(HEARTBEAT_KEY)
