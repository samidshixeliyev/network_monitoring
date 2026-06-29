"""
Idempotent seed: permissions, roles (with their permission sets) + the default
manager account. Run after migrations: docker compose exec api python seed.py
"""
import asyncio

from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.permissions import ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS
from app.models import Permission, Role, User

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


async def seed() -> None:
    engine = create_async_engine(settings.sqlalchemy_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        async with session.begin():
            # 1. Permissions
            existing_perms = {
                p.name: p for p in await session.scalars(select(Permission))
            }
            for name in ALL_PERMISSIONS:
                if name not in existing_perms:
                    p = Permission(name=name)
                    session.add(p)
                    existing_perms[name] = p
            await session.flush()

            # 2. Roles + their permission sets
            for role_name, perm_names in DEFAULT_ROLE_PERMISSIONS.items():
                role = await session.scalar(
                    select(Role).options(selectinload(Role.permissions)).where(Role.name == role_name)
                )
                if role is None:
                    role = Role(name=role_name)
                    session.add(role)
                    role.permissions = []
                # Grant any missing permissions (idempotent; never revokes).
                have = {p.name for p in role.permissions}
                for pn in perm_names:
                    if pn not in have:
                        role.permissions.append(existing_perms[pn])
            await session.flush()

            # 3. Default manager account
            manager_role = await session.scalar(select(Role).where(Role.name == "manager"))
            assert manager_role is not None, "manager role missing after flush"

            if not await session.scalar(
                select(User).where(User.email == settings.DEFAULT_MANAGER_EMAIL)
            ):
                session.add(
                    User(
                        email=settings.DEFAULT_MANAGER_EMAIL,
                        hashed_password=_pwd.hash(settings.DEFAULT_MANAGER_PASSWORD),
                        role_id=manager_role.id,
                    )
                )

    await engine.dispose()
    print(f"[seed] done — roles+permissions seeded; manager: {settings.DEFAULT_MANAGER_EMAIL}")


if __name__ == "__main__":
    asyncio.run(seed())
