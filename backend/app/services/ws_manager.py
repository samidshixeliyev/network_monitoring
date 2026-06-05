import asyncio
import json
from datetime import datetime
from uuid import UUID

from fastapi import WebSocket


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

    async def broadcast(self, device_id: UUID, status: str, last_checked_at: datetime) -> None:
        payload = json.dumps(
            {
                "device_id": str(device_id),
                "status": status,
                "last_checked_at": last_checked_at.isoformat(),
            }
        )
        async with self._lock:
            connections = set(self._connections)

        dead: set[WebSocket] = set()
        for ws in connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.add(ws)

        if dead:
            async with self._lock:
                self._connections -= dead


ws_manager = WebSocketManager()
