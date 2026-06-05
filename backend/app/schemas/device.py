import ipaddress
import socket
import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, field_validator

from app.models.device import DeviceStatus


def _resolve_to_ip(value: object) -> str:
    s = str(value).strip()
    # Already a valid IP — return as-is
    try:
        ipaddress.ip_address(s)
        return s
    except ValueError:
        pass
    # Treat as hostname — resolve synchronously (Pydantic validators are sync)
    try:
        return socket.gethostbyname(s)
    except socket.gaierror:
        raise ValueError(f"Not a valid IP address and could not resolve hostname: {s!r}")


class DeviceBase(BaseModel):
    vendor_name: str
    ip_address: str
    model_name: str | None = None
    description: str | None = None
    location_text: str | None = None
    is_enabled: bool = True
    latitude: Annotated[float, Field(ge=-90.0, le=90.0)] | None = None
    longitude: Annotated[float, Field(ge=-180.0, le=180.0)] | None = None

    @field_validator("ip_address", mode="before")
    @classmethod
    def validate_ip(cls, v: object) -> str:
        return _resolve_to_ip(v)


class DeviceCreate(DeviceBase):
    pass


class DeviceUpdate(BaseModel):
    vendor_name: str | None = None
    ip_address: str | None = None
    model_name: str | None = None
    description: str | None = None
    location_text: str | None = None
    is_enabled: bool | None = None
    latitude: Annotated[float, Field(ge=-90.0, le=90.0)] | None = None
    longitude: Annotated[float, Field(ge=-180.0, le=180.0)] | None = None

    @field_validator("ip_address", mode="before")
    @classmethod
    def validate_ip(cls, v: object) -> str | None:
        if v is None:
            return None
        return _resolve_to_ip(v)


class DeviceRead(DeviceBase):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    current_status: DeviceStatus
    last_checked_at: datetime | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
