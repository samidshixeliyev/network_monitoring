from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(
    settings.sqlalchemy_url,
    echo=settings.ENVIRONMENT == "development",
    pool_pre_ping=True,
    # The collector runs ping/SSH/SNMP loops with concurrency semaphores summing
    # to ~112; even though those loops now release their connection before the
    # slow network I/O, brief write-phase spikes need headroom well above the
    # default 5+10. 20 persistent + 40 overflow keeps checks from serializing on
    # pool-timeout without over-provisioning Postgres connections.
    pool_size=20,
    max_overflow=40,
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
