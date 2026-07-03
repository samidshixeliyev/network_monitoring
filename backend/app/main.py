import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.core.logging import setup_logging

setup_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.core.config import settings
    from app.services.cache_warm import warm_cache_if_cold
    from app.services.state_cache import close_redis
    from app.services.ws_manager import redis_status_subscriber

    await warm_cache_if_cold()

    # The gateway always runs the Redis→WS fan-out subscriber. Probing runs in a
    # separate collector process by default; only embed it for all-in-one dev.
    tasks = [asyncio.create_task(redis_status_subscriber())]
    if settings.EMBEDDED_COLLECTOR:
        from app.services.ping_scheduler import ping_loop
        from app.services.snmp_collector import snmp_poll_loop
        from app.services.ssh_collector import ssh_poll_loop

        logger.info("EMBEDDED_COLLECTOR=true — running probe loops in the API process")
        tasks += [
            asyncio.create_task(ping_loop()),
            asyncio.create_task(ssh_poll_loop()),
            asyncio.create_task(snmp_poll_loop()),
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

from app.api.routes import audit, auth, devices, events, monitor, sla, ws  # noqa: E402

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(events.router)
app.include_router(audit.router)
app.include_router(monitor.router)
app.include_router(sla.router)
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
