"""
Idempotent seed: creates roles (manager, user) + the default manager account.
Run after migrations: docker compose exec api python seed.py
"""
import asyncio

from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models import Role, User

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


async def seed() -> None:
    engine = create_async_engine(settings.sqlalchemy_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        async with session.begin():
            for role_name in ("manager", "user"):
                if not await session.scalar(select(Role).where(Role.name == role_name)):
                    session.add(Role(name=role_name))
            await session.flush()

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
    print(f"[seed] done — manager account: {settings.DEFAULT_MANAGER_EMAIL}")


if __name__ == "__main__":
    asyncio.run(seed())
