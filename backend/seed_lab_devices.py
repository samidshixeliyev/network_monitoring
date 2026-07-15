"""
Seed the Docker-lab devices — these map to the container static IPs defined in
lab/docker-compose.yml (172.30.0.0/24). Unlike the fake TEST-NET bots, these are
REAL, pingable containers: stop one with `docker stop <name>` and the monitor
detects it going UNKNOWN → OFFLINE for real.

Run inside the api container (the lab compose does this automatically).
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

# (vendor_name, container_ip, model, type, critical, city, lat, lon)
# IPs must match the ipv4_address values in lab/docker-compose.yml.
LAB = [
    ("Cisco ISR 4331",      "172.30.0.11", "ISR4331", "router",   True,  "Bakı",     40.4093, 49.8671),
    ("Juniper MX204",       "172.30.0.12", "MX204",   "router",   False, "Gəncə",    40.6828, 46.3606),
    ("Cisco Catalyst 9300", "172.30.0.13", "C9300",   "switch",   False, "Sumqayıt", 40.5897, 49.6686),
    ("Juniper SRX340",      "172.30.0.14", "SRX340",  "firewall", True,  "Lənkəran", 38.7529, 48.8508),
    ("Juniper vJunos R1",   "172.30.0.15", "vJunos",  "router",   False, "Naxçıvan", 39.2090, 45.4122),
]

# All lab device containers run sshd with these credentials (see
# lab/device/Dockerfile + DEVICE_ROOT_PASSWORD in lab/docker-compose.yml).
SSH_USER = "root"
SSH_PASS = "Lab_Dev1ce!"
# All lab device containers run snmpd with this community (lab/device/Dockerfile).
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

        created = 0
        for vendor, ip, model, dtype, crit, city, lat, lon in LAB:
            exists = await session.scalar(select(Device).where(Device.ip_address == ip))
            if exists:
                exists.vendor_name = vendor
                exists.model_name = model
                exists.device_type = dtype
                exists.is_critical = crit
                exists.location_text = city
                exists.ssh_enabled = True
                exists.ssh_username = SSH_USER
                exists.ssh_password = SSH_PASS
                exists.ssh_port = 22
                exists.snmp_enabled = True
                exists.snmp_community = SNMP_COMMUNITY
                exists.snmp_port = 161
                continue
            session.add(
                Device(
                    vendor_name=vendor, ip_address=ip, model_name=model,
                    device_type=dtype, is_critical=crit, location_text=city,
                    latitude=lat, longitude=lon, created_by=manager.id,
                    ssh_enabled=True, ssh_username=SSH_USER, ssh_password=SSH_PASS,
                    ssh_port=22,
                    snmp_enabled=True, snmp_community=SNMP_COMMUNITY, snmp_port=161,
                )
            )
            created += 1
        await session.commit()

    await engine.dispose()
    print(f"[seed_lab] {created} new lab device(s); {len(LAB)} total mapped to containers")


if __name__ == "__main__":
    asyncio.run(seed())
