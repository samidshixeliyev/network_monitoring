import asyncio
import logging
from datetime import datetime, timezone

from icmplib import async_multiping
from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models import Device, EventLog
from app.models.device import DeviceStatus
from app.models.event_log import EventType
from app.services.ws_manager import ws_manager

logger = logging.getLogger(__name__)


async def _tick() -> None:
    async with AsyncSessionLocal() as session:
        devices = list(await session.scalars(select(Device).where(Device.is_enabled.is_(True))))
        if not devices:
            return

        # asyncpg returns IPv4Address objects for INET columns — stringify them
        ip_map: dict[str, Device] = {str(d.ip_address): d for d in devices}
        now = datetime.now(timezone.utc)

        try:
            results = await async_multiping(
                list(ip_map.keys()), count=1, timeout=1, privileged=True
            )
        except Exception as exc:
            logger.error("async_multiping error: %s", exc)
            return

        for result in results:
            device = ip_map.get(result.address)
            if device is None:
                continue

            prev_status = device.current_status
            device.last_checked_at = now

            if result.is_alive:
                device.consecutive_failures = 0
                new_status = DeviceStatus.online
            else:
                device.consecutive_failures += 1
                # Anti-flap: only flip to offline after FLAP_THRESHOLD consecutive misses
                new_status = (
                    DeviceStatus.offline
                    if device.consecutive_failures >= settings.FLAP_THRESHOLD
                    else prev_status
                )

            if new_status != prev_status:
                device.current_status = new_status
                event_type = (
                    EventType.came_online
                    if new_status == DeviceStatus.online
                    else EventType.went_offline
                )
                session.add(EventLog(device_id=device.id, event_type=event_type))
                await session.flush()
                await ws_manager.broadcast(device.id, new_status.value, now)
                logger.info(
                    "device %s: %s → %s",
                    device.ip_address,
                    prev_status.value,
                    new_status.value,
                )

        await session.commit()


async def ping_loop() -> None:
    logger.info(
        "ping loop started (interval=%ds, flap_threshold=%d)",
        settings.PING_INTERVAL_SECONDS,
        settings.FLAP_THRESHOLD,
    )
    while True:
        try:
            await _tick()
        except Exception as exc:
            logger.error("ping tick error: %s", exc, exc_info=True)
        await asyncio.sleep(settings.PING_INTERVAL_SECONDS)
