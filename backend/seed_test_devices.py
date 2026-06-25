"""
Seed a set of BOT / test devices spread across Azerbaijan so the map and the
manual up/down simulation can be exercised without real hardware.

IPs use the 192.0.2.0/24 TEST-NET-1 range (RFC 5737) — reserved for
documentation and guaranteed not to respond to ping, so in SIMULATION_MODE
their status is fully controlled by you.

Run (from backend/, venv active):  python seed_test_devices.py
Idempotent — existing IPs are skipped.
"""
import asyncio
import sys

# Windows consoles default to a legacy code page that can't print Azerbaijani
# characters — force UTF-8 so the summary doesn't crash.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models import Device, User

# (vendor_name, ip, model, type, critical, city, lat, lon)
BOTS = [
    ("Bot-Router-Baku",       "192.0.2.11", "Virtual-RTR", "router",   True,  "Bakı",       40.4093, 49.8671),
    ("Bot-Switch-Sumqayit",   "192.0.2.12", "Virtual-SW",  "switch",   False, "Sumqayıt",   40.5897, 49.6686),
    ("Bot-Router-Ganja",      "192.0.2.13", "Virtual-RTR", "router",   False, "Gəncə",      40.6828, 46.3606),
    ("Bot-Switch-Mingachevir","192.0.2.14", "Virtual-SW",  "switch",   False, "Mingəçevir", 40.7700, 47.0489),
    ("Bot-Server-Shaki",      "192.0.2.15", "Virtual-SRV", "server",   True,  "Şəki",       41.1975, 47.1706),
    ("Bot-Switch-Quba",       "192.0.2.16", "Virtual-SW",  "switch",   False, "Quba",       41.3608, 48.5128),
    ("Bot-Firewall-Lankaran", "192.0.2.17", "Virtual-FW",  "firewall", True,  "Lənkəran",   38.7529, 48.8508),
    ("Bot-Router-Nakhchivan", "192.0.2.18", "Virtual-RTR", "router",   False, "Naxçıvan",   39.2089, 45.4122),
]


async def seed() -> None:
    engine = create_async_engine(settings.sqlalchemy_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        manager = await session.scalar(
            select(User).where(User.email == settings.DEFAULT_MANAGER_EMAIL)
        )
        if manager is None:
            raise SystemExit("No manager user found — run seed.py first.")

        created = []
        for vendor, ip, model, dtype, crit, city, lat, lon in BOTS:
            exists = await session.scalar(select(Device).where(Device.ip_address == ip))
            if exists:
                # keep test data in sync on re-run
                exists.vendor_name = vendor
                exists.model_name = model
                exists.device_type = dtype
                exists.is_critical = crit
                exists.location_text = city
                continue
            session.add(
                Device(
                    vendor_name=vendor,
                    ip_address=ip,
                    model_name=model,
                    device_type=dtype,
                    is_critical=crit,
                    location_text=city,
                    latitude=lat,
                    longitude=lon,
                    created_by=manager.id,
                )
            )
            created.append((vendor, ip, city))
        await session.commit()

    await engine.dispose()

    if created:
        print(f"[seed] created {len(created)} bot devices:")
        for vendor, ip, city in created:
            print(f"  {ip:<12} {vendor}  ({city})")
    else:
        print("[seed] all bot devices already present — nothing to do")


if __name__ == "__main__":
    asyncio.run(seed())
