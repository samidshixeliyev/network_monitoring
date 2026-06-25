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
    from app.services.ping_scheduler import ping_loop

    task = asyncio.create_task(ping_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    logger.info("ping loop stopped")


app = FastAPI(title="Network Monitor", version="0.1.0", lifespan=lifespan)

from app.api.routes import auth, devices, events, ws  # noqa: E402

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(events.router)
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
