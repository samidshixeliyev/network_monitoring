import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.core.logging import setup_logging

setup_logging()
logger = logging.getLogger(__name__)


async def _warm_cache_if_cold() -> None:
    """Seed the Redis snapshot from Postgres if the cache is empty (cold start /
    fresh Redis). On a warm cache this is a no-op, so the map survives restarts."""
    from sqlalchemy import select

    from app.db.session import AsyncSessionLocal
    from app.models import Device
    from app.schemas.device import serialize_device
    from app.services import state_cache

    try:
        existing = await state_cache.get_all_devices()
        if existing:
            logger.info("device snapshot cache already warm (%d device(s))", len(existing))
            return
        async with AsyncSessionLocal() as session:
            devices = list(await session.scalars(select(Device).order_by(Device.created_at)))
        await state_cache.warm_devices([serialize_device(d) for d in devices])
    except Exception as exc:  # noqa: BLE001 — never block startup on cache warm
        logger.warning("cache warm skipped: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.ping_scheduler import ping_loop
    from app.services.ssh_collector import ssh_poll_loop
    from app.services.state_cache import close_redis
    from app.services.ws_manager import redis_status_subscriber

    await _warm_cache_if_cold()

    tasks = [
        asyncio.create_task(redis_status_subscriber()),
        asyncio.create_task(ping_loop()),
        asyncio.create_task(ssh_poll_loop()),
    ]
    yield
    for task in tasks:
        task.cancel()
    for task in tasks:
        try:
            await task
        except asyncio.CancelledError:
            pass
    await close_redis()
    logger.info("background loops stopped")


app = FastAPI(title="Network Monitor", version="0.1.0", lifespan=lifespan)

from app.api.routes import audit, auth, devices, events, ws  # noqa: E402

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(events.router)
app.include_router(audit.router)
app.include_router(ws.router)

# ── Offline basemap tiles ───────────────────────────────────────────────────
# When .ecw/.tif imagery is converted to an XYZ tile pyramid (see README), drop
# the result into backend/tiles/{z}/{x}/{y}.png and it is served here, fully
# offline. Until then the frontend falls back to the bundled GeoJSON outline.
_TILES_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "tiles")
if os.path.isdir(_TILES_DIR):
    app.mount("/tiles", StaticFiles(directory=_TILES_DIR), name="tiles")
    logger.info("serving basemap tiles from %s", os.path.abspath(_TILES_DIR))


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
