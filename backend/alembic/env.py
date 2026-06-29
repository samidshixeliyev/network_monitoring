import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import create_async_engine
from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# All models must be imported before target_metadata is read so the mapper
# registry is fully populated and autogenerate can diff the full schema.
from app.core.config import settings  # noqa: E402
from app.models import Base  # noqa: E402

target_metadata = Base.metadata

# Build the URL from app settings (postgresql+asyncpg://…). We pass it straight
# to create_async_engine rather than through alembic.ini so configparser does
# not try to interpolate any '%'-encoded characters in the password.
DB_URL = settings.sqlalchemy_url


def run_migrations_offline() -> None:
    context.configure(
        url=DB_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = create_async_engine(DB_URL, poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
