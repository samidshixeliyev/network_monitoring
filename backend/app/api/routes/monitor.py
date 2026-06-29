from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import get_current_user
from app.core.config import settings
from app.models import User
from app.services import state_cache

router = APIRouter(prefix="/api/monitor", tags=["monitor"])


class MonitorStatus(BaseModel):
    heartbeat: str | None          # ISO timestamp of the last completed probe cycle
    age_seconds: float | None      # how long ago that was
    healthy: bool                  # False → the collector looks stuck/down


@router.get("/heartbeat", response_model=MonitorStatus)
async def monitor_heartbeat(_: User = Depends(get_current_user)) -> MonitorStatus:
    """Self-monitoring: 'last probe cycle completed Xs ago', so users can tell
    'all healthy' from 'the monitor itself is stuck'."""
    hb = await state_cache.get_heartbeat()
    if not hb:
        return MonitorStatus(heartbeat=None, age_seconds=None, healthy=False)
    try:
        ts = datetime.fromisoformat(hb)
        age = (datetime.now(timezone.utc) - ts).total_seconds()
    except ValueError:
        return MonitorStatus(heartbeat=hb, age_seconds=None, healthy=False)
    # Stale if no cycle within ~4× the slow interval (min 60s).
    limit = max(60, settings.PING_INTERVAL_SECONDS * 4)
    return MonitorStatus(heartbeat=hb, age_seconds=round(age, 1), healthy=age <= limit)
