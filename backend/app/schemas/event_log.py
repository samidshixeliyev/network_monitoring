import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.event_log import EventType


class EventLogRead(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    device_id: uuid.UUID
    event_type: EventType
    created_at: datetime
