"""Warm the Redis device snapshot from Postgres if the cache is cold.

Shared by the API process (so the map survives a restart) and the standalone
collector (so a snapshot exists even before any status change). A no-op when the
cache is already warm; never raises (must not block startup)."""
import logging

from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models import Device
from app.schemas.device import serialize_device
from app.services import state_cache

logger = logging.getLogger(__name__)


async def warm_cache_if_cold() -> None:
    try:
        if await state_cache.cache_is_current():
            existing = await state_cache.get_all_devices()
            if existing:
                logger.info("device snapshot cache already warm (%d device(s))", len(existing))
                return
        async with AsyncSessionLocal() as session:
            devices = list(await session.scalars(select(Device).order_by(Device.created_at)))
        await state_cache.warm_devices([serialize_device(d) for d in devices])
    except Exception as exc:  # noqa: BLE001 — never block startup on cache warm
        logger.warning("cache warm skipped: %s", exc)
