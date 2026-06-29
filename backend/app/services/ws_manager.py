"""
WebSocket fan-out for one gateway process.

Each gateway holds only its OWN local WebSocket connections. Status changes do
NOT travel between processes through this object — they travel through Redis
pub/sub: the collector publishes to `status:changes`, every gateway runs one
`redis_status_subscriber()` task that receives changes and fans them out to its
local clients via `fanout()`. This keeps gateways stateless relative to each
other, so many can run behind a load balancer (each subscribes to Redis once,
not once per user).
"""
import asyncio
import json
import logging

from fastapi import WebSocket

from app.services import state_cache

logger = logging.getLogger(__name__)

# Status changes are buffered for this window and flushed as ONE batch frame, so
# a flap storm becomes a single "N devices changed" message instead of N frames.
COALESCE_WINDOW_SECONDS = 0.25


class WebSocketManager:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._connections.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(ws)

    async def fanout(self, message: str) -> None:
        """Send a raw text frame to every local connection."""
        async with self._lock:
            connections = set(self._connections)

        dead: set[WebSocket] = set()
        for ws in connections:
            try:
                await ws.send_text(message)
            except Exception:
                dead.add(ws)

        if dead:
            async with self._lock:
                self._connections -= dead


ws_manager = WebSocketManager()


async def redis_status_subscriber() -> None:
    """Subscribe to the Redis status channel ONCE per gateway and fan changes out
    to local WebSocket clients, COALESCED into ~250ms batches. Incoming changes
    are buffered (latest-wins per device); a flusher task emits one batch frame:

        {"type": "batch", "changes": [{device_id, status, last_checked_at}, ...]}

    This turns a flap storm of N messages into a single frame, so 100+ clients
    aren't each woken N times. Reconnects automatically if Redis drops."""
    pending: dict[str, dict] = {}
    lock = asyncio.Lock()

    async def flusher() -> None:
        while True:
            await asyncio.sleep(COALESCE_WINDOW_SECONDS)
            async with lock:
                if not pending:
                    continue
                changes = list(pending.values())
                pending.clear()
            await ws_manager.fanout(json.dumps({"type": "batch", "changes": changes}))

    flush_task = asyncio.create_task(flusher())
    try:
        while True:  # reconnect loop — survives transient Redis drops
            pubsub = state_cache.get_redis().pubsub()
            try:
                await pubsub.subscribe(state_cache.CHANGES_CHANNEL)
                logger.info("subscribed to Redis channel %s", state_cache.CHANGES_CHANNEL)
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    data = message.get("data")
                    if not isinstance(data, str):
                        continue
                    try:
                        change = json.loads(data)
                    except ValueError:
                        continue
                    async with lock:
                        pending[change["device_id"]] = change  # latest-wins per device
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — reconnect after a short pause
                logger.warning("redis subscriber dropped, reconnecting: %s", exc)
                await asyncio.sleep(1.0)
            finally:
                try:
                    await pubsub.aclose()
                except Exception:  # noqa: BLE001
                    pass
    except asyncio.CancelledError:
        raise
    finally:
        flush_task.cancel()
        try:
            await flush_task
        except asyncio.CancelledError:
            pass
