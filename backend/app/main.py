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
        from app.services.alerts import alert_loop
        from app.services.discovery import discovery_loop
        from app.services.ping_scheduler import ping_loop
        from app.services.snmp_collector import snmp_poll_loop
        from app.services.ssh_collector import ssh_poll_loop
        from app.services.syslog_listener import syslog_loop

        logger.info("EMBEDDED_COLLECTOR=true — running probe loops in the API process")
        tasks += [
            asyncio.create_task(ping_loop()),
            asyncio.create_task(ssh_poll_loop()),
            asyncio.create_task(snmp_poll_loop()),
            asyncio.create_task(alert_loop()),
            asyncio.create_task(syslog_loop()),
            asyncio.create_task(discovery_loop()),
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

from app.api.routes import (  # noqa: E402
    admin,
    audit,
    auth,
    device_links,
    devices,
    discovery,
    events,
    monitor,
    sla,
    snmp_traps,
    syslog,
    ws,
)

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(devices.router)
app.include_router(device_links.router)
app.include_router(events.router)
app.include_router(audit.router)
app.include_router(monitor.router)
app.include_router(sla.router)
app.include_router(syslog.router)
app.include_router(snmp_traps.router)
app.include_router(discovery.router)
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


@app.get("/healthz")
async def healthz() -> dict:
    """Unauthenticated liveness for the EXTERNAL watchdog (tools/watchdog.py):
    is the API up AND is the collector actually completing probe cycles?
    Exposes only a heartbeat age — no device data."""
    from datetime import datetime, timezone

    from app.core.config import settings
    from app.services import state_cache

    age: float | None = None
    try:
        hb = await state_cache.get_heartbeat()
        if hb:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(hb)).total_seconds()
    except Exception as exc:  # noqa: BLE001 — Redis down → collector unknown
        logger.warning("healthz heartbeat read failed: %s", exc)
    limit = max(60, settings.PING_INTERVAL_SECONDS * 4)
    healthy = age is not None and age <= limit
    return {
        "status": "ok",
        "collector_healthy": healthy,
        "heartbeat_age_seconds": round(age, 1) if age is not None else None,
    }
