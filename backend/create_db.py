"""
Create the target PostgreSQL database if it does not exist (connects to the
`postgres` maintenance DB first). The timescale/timescaledb Docker image already
auto-creates POSTGRES_DB, so this is mainly for non-Docker / local setups.
Reads the same POSTGRES_* env vars as the app. Idempotent.
"""
import asyncio
import os

import asyncpg

host = os.getenv("POSTGRES_HOST", "localhost")
port = int(os.getenv("POSTGRES_PORT", "5432"))
user = os.getenv("POSTGRES_USER", "postgres")
password = os.getenv("POSTGRES_PASSWORD", "")
database = os.getenv("POSTGRES_DB", "network")


async def main() -> None:
    conn = await asyncpg.connect(
        host=host, port=port, user=user, password=password, database="postgres"
    )
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", database)
        if not exists:
            # CREATE DATABASE cannot run in a transaction or with a bind param.
            await conn.execute(f'CREATE DATABASE "{database}"')
            print(f"[create_db] created database: {database}")
        else:
            print(f"[create_db] database ready: {database}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
