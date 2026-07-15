"""
Seed the REAL vJunos-router lab device (172.30.0.21).

Unlike the lightweight Alpine stand-ins (seed_lab_devices.py), this row points at
an actual Junos VM run from a vrnetlab image (see lab/vjunos/README.md). SSH into
it — from the web terminal — drops you into the genuine Junos CLI, and SNMP polls
the real Junos agent.

Run AFTER the vjunos container is up and the VM has booted (~3-5 min):
    docker compose exec api python seed_junos_device.py
Idempotent.
"""
import asyncio
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models import Device, User

# Must match the ipv4_address of the `vjunos-baki` service in docker-compose.yml.
IP = "172.30.0.21"
VENDOR = "Juniper vJunos-router"
MODEL = "vJunos"
CITY = "Bakı (lab)"
LAT, LON = 40.3777, 49.8920

# vrnetlab's default Junos credentials (admin / admin@123). Override here if you
# changed them in lab/vjunos/junos.set.cfg.
SSH_USER = "admin"
SSH_PASS = "admin@123"
# SNMP community set by lab/vjunos/junos.set.cfg.
SNMP_COMMUNITY = "public"


async def seed() -> None:
    engine = create_async_engine(settings.sqlalchemy_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        manager = await session.scalar(
            select(User).where(User.email == settings.DEFAULT_MANAGER_EMAIL)
        )
        if manager is None:
            raise SystemExit("No manager user found — run seed.py first.")

        device = await session.scalar(select(Device).where(Device.ip_address == IP))
        fields = dict(
            vendor_name=VENDOR, model_name=MODEL, device_type="router",
            is_critical=True, location_text=CITY,
            ssh_enabled=True, ssh_username=SSH_USER, ssh_password=SSH_PASS, ssh_port=22,
            snmp_enabled=True, snmp_community=SNMP_COMMUNITY, snmp_port=161,
        )
        if device:
            for k, v in fields.items():
                setattr(device, k, v)
            action = "updated"
        else:
            session.add(Device(ip_address=IP, latitude=LAT, longitude=LON,
                               created_by=manager.id, **fields))
            action = "created"
        await session.commit()

    await engine.dispose()
    print(f"[seed_junos] vJunos device {IP} {action} (ssh {SSH_USER}, snmp {SNMP_COMMUNITY})")


if __name__ == "__main__":
    asyncio.run(seed())
