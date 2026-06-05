import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
