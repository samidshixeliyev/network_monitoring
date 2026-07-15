import asyncio
import ipaddress
import socket
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

from app.models.device import DeviceStatus, DeviceType


def _validate_host(value: object) -> str:
    """Validate an IP literal, or accept a plausible hostname for LATER async
    resolution in the route. DNS must never run here: Pydantic validators are
    sync, and socket.gethostbyname would block the whole async event loop
    (freezing pings/websockets). Actual resolution is done by resolve_host_to_ip.
    """
    s = str(value).strip()
    if not s:
        raise ValueError("ip_address must not be empty")
    try:
        ipaddress.ip_address(s)  # already an IP literal → accept as-is
    except ValueError:
        # Not an IP: treat as a hostname (resolved off the event loop in the
        # route). Reject obvious garbage — no whitespace/control chars — but do
        # not touch DNS here.
        if any(c.isspace() for c in s):
            raise ValueError(f"Not a valid IP address or hostname: {s!r}")
    return s


async def resolve_host_to_ip(value: str) -> str:
    """Resolve a hostname to an IP literal WITHOUT blocking the event loop
    (loop.getaddrinfo runs on the resolver thread pool). Returns the input
    unchanged when it is already an IP. Raises ValueError on resolution failure.
    Called by the device create/update routes after schema validation."""
    s = value.strip()
    try:
        ipaddress.ip_address(s)
        return s
    except ValueError:
        pass
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(s, None)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve hostname {s!r}: {exc}")
    if not infos:
        raise ValueError(f"Could not resolve hostname {s!r}")
    return str(infos[0][4][0])


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
    # SNMP telemetry config (the community string is write-only, like ssh_password).
    snmp_enabled: bool = False
    snmp_port: Annotated[int, Field(ge=1, le=65535)] = 161
    snmp_version: Literal["2c", "3"] = "2c"
    # SNMPv3 (USM) — only used when snmp_version == "3"; keys are write-only.
    snmp_v3_user: str | None = None
    snmp_v3_auth_proto: Literal["none", "md5", "sha", "sha256"] = "sha"
    snmp_v3_priv_proto: Literal["none", "des", "aes", "aes256"] = "aes"
    # Topology: parent device (alarms suppressed when the parent is down).
    parent_id: uuid.UUID | None = None
    # Multi-condition checks (beyond ICMP): optional TCP port / HTTP URL.
    check_tcp_port: Annotated[int, Field(ge=1, le=65535)] | None = None
    check_http_url: str | None = None
    check_http_expect: Annotated[int, Field(ge=100, le=599)] | None = None

    @field_validator("ip_address", mode="before")
    @classmethod
    def validate_ip(cls, v: object) -> str:
        return _validate_host(v)


class DeviceCreate(DeviceBase):
    ssh_password: str | None = None
    snmp_community: str | None = None
    snmp_v3_auth_key: str | None = None
    snmp_v3_priv_key: str | None = None


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
    snmp_enabled: bool | None = None
    snmp_port: Annotated[int, Field(ge=1, le=65535)] | None = None
    snmp_community: str | None = None
    snmp_version: Literal["2c", "3"] | None = None
    snmp_v3_user: str | None = None
    snmp_v3_auth_proto: Literal["none", "md5", "sha", "sha256"] | None = None
    snmp_v3_priv_proto: Literal["none", "des", "aes", "aes256"] | None = None
    snmp_v3_auth_key: str | None = None
    snmp_v3_priv_key: str | None = None
    parent_id: uuid.UUID | None = None
    check_tcp_port: Annotated[int, Field(ge=1, le=65535)] | None = None
    check_http_url: str | None = None
    check_http_expect: Annotated[int, Field(ge=100, le=599)] | None = None

    @field_validator("ip_address", mode="before")
    @classmethod
    def validate_ip(cls, v: object) -> str | None:
        if v is None:
            return None
        return _validate_host(v)


class DeviceSimulate(BaseModel):
    """Manually force a device's status (test/simulation)."""
    status: Literal["online", "offline"]


class DeviceRead(DeviceBase):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    current_status: DeviceStatus
    last_checked_at: datetime | None
    # Maintenance / ack / mute + multi-condition state (read-only)
    maintenance_until: datetime | None
    is_muted: bool
    alarm_acked_at: datetime | None
    service_ok: bool | None
    service_detail: str | None
    # SSH telemetry (read-only; password is never returned)
    ssh_status: str
    ssh_hostname: str | None
    ssh_uptime: str | None
    ssh_facts: str | None
    ssh_collected_at: datetime | None
    # SNMP telemetry (read-only; community string is never returned)
    snmp_status: str
    snmp_facts: str | None
    snmp_collected_at: datetime | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


def serialize_device(device: object) -> dict:
    """ORM Device → JSON-able dict (DeviceRead shape) for the Redis snapshot
    cache. The write-only ssh_password is excluded by DeviceRead."""
    return DeviceRead.model_validate(device).model_dump(mode="json")


class SshCheckResult(BaseModel):
    """On-demand SSH collection result returned by POST /{id}/ssh-check."""
    status: str
    detail: str | None = None
    hostname: str | None = None
    uptime: str | None = None
    facts: dict | None = None


class SnmpCheckResult(BaseModel):
    """On-demand SNMP collection result returned by POST /{id}/snmp-check."""
    status: str
    detail: str | None = None
    facts: dict | None = None


class SnmpInventoryResult(BaseModel):
    """Comprehensive on-demand SNMP walk returned by POST /{id}/snmp-inventory.
    `data` is a loose category bag (system/resources/storage/interfaces/sensors/
    vlans/mac_table/arp/routes/qos/vpn/wireless/ups + meta) — persisted nowhere."""
    status: str
    detail: str | None = None
    data: dict | None = None
