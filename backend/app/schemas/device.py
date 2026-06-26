import ipaddress
import socket
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

from app.models.device import DeviceStatus, DeviceType


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
    device_type: DeviceType = DeviceType.other
    is_critical: bool = False
    is_enabled: bool = True
    latitude: Annotated[float, Field(ge=-90.0, le=90.0)] | None = None
    longitude: Annotated[float, Field(ge=-180.0, le=180.0)] | None = None
    # SSH telemetry config (the password is write-only — see DeviceCreate/Update).
    ssh_enabled: bool = False
    ssh_port: Annotated[int, Field(ge=1, le=65535)] = 22
    ssh_username: str | None = None

    @field_validator("ip_address", mode="before")
    @classmethod
    def validate_ip(cls, v: object) -> str:
        return _resolve_to_ip(v)


class DeviceCreate(DeviceBase):
    ssh_password: str | None = None


class DeviceUpdate(BaseModel):
    vendor_name: str | None = None
    ip_address: str | None = None
    model_name: str | None = None
    description: str | None = None
    location_text: str | None = None
    device_type: DeviceType | None = None
    is_critical: bool | None = None
    is_enabled: bool | None = None
    latitude: Annotated[float, Field(ge=-90.0, le=90.0)] | None = None
    longitude: Annotated[float, Field(ge=-180.0, le=180.0)] | None = None
    ssh_enabled: bool | None = None
    ssh_port: Annotated[int, Field(ge=1, le=65535)] | None = None
    ssh_username: str | None = None
    ssh_password: str | None = None

    @field_validator("ip_address", mode="before")
    @classmethod
    def validate_ip(cls, v: object) -> str | None:
        if v is None:
            return None
        return _resolve_to_ip(v)


class DeviceSimulate(BaseModel):
    """Manually force a device's status (test/simulation)."""
    status: Literal["online", "offline"]


class DeviceRead(DeviceBase):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    current_status: DeviceStatus
    last_checked_at: datetime | None
    # SSH telemetry (read-only; password is never returned)
    ssh_status: str
    ssh_hostname: str | None
    ssh_uptime: str | None
    ssh_facts: str | None
    ssh_collected_at: datetime | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class SshCheckResult(BaseModel):
    """On-demand SSH collection result returned by POST /{id}/ssh-check."""
    status: str
    detail: str | None = None
    hostname: str | None = None
    uptime: str | None = None
    facts: dict | None = None
