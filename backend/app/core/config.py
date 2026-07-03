from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Look for .env both in the project root (when running from backend/) and in
    # the current dir. A later file overrides an earlier one. OS env vars (e.g.
    # injected by docker-compose) always take precedence over both.
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    # ── PostgreSQL + TimescaleDB connection parts ───────────────────────────
    # A single timescale/timescaledb container (Postgres + Timescale extension)
    # holds both the relational data and the time-series ping history.
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_DB: str = "network"
    POSTGRES_USER: str = "postgres"
    POSTGRES_PASSWORD: str = "changeme"

    # Optional full override. If set, it is used verbatim and the parts above
    # are ignored (e.g. to point at a managed Postgres instance).
    DATABASE_URL: str | None = None

    # ── Redis: current-state cache + pub/sub bus ────────────────────────────
    # The single collector publishes status changes to Redis; the API/WS
    # gateways subscribe and serve the dashboard snapshot from the Redis cache
    # instead of hammering Postgres on every login.
    REDIS_URL: str = "redis://localhost:6379/0"

    SECRET_KEY: str = "change-this-secret"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    # Healthy devices are probed at this (slow) cadence.
    PING_INTERVAL_SECONDS: int = 30
    # Recently-flapping / non-online devices are probed faster, so an outage is
    # detected and a recovery is confirmed quickly. A device is "volatile" (fast)
    # while it is not online or for this window after its last status change.
    PING_FAST_INTERVAL_SECONDS: int = 5
    PING_VOLATILE_WINDOW_SECONDS: int = 120
    # ICMP packets sent per check. Long network paths can drop some packets, so
    # the device counts as alive if AT LEAST ONE of these replies.
    PING_COUNT: int = 3
    # Consecutive fully-failed checks before a device flips OFFLINE. The first
    # failed check moves it to UNKNOWN (yellow); reaching this count → OFFLINE.
    FLAP_THRESHOLD: int = 2
    PING_TIMEOUT_SECONDS: int = 1

    # The probing loops (ICMP + SSH) run in a SEPARATE collector process by
    # default (single source of truth — see app/collector). When True, the API
    # process also runs them — convenient for all-in-one local dev.
    EMBEDDED_COLLECTOR: bool = True

    # How devices are probed:
    #   "system"  → the OS `ping` command (works on Windows WITHOUT admin) — default
    #   "icmplib" → raw ICMP via icmplib (faster/batched, but needs admin/CAP_NET_RAW)
    PING_METHOD: str = "system"

    # When true, the ping loop is disabled and device status is driven only by the
    # manual /simulate endpoint — useful for demos without real devices.
    SIMULATION_MODE: bool = False

    # ── SSH telemetry collector ─────────────────────────────────────────────
    # When enabled, a background loop logs into ssh_enabled devices and pulls
    # facts (hostname/uptime/interfaces) on top of ICMP up/down.
    SSH_ENABLED: bool = False
    SSH_POLL_INTERVAL_SECONDS: int = 60
    SSH_CONNECT_TIMEOUT_SECONDS: int = 8

    # ── SNMP telemetry collector ────────────────────────────────────────────
    # When enabled, a background loop polls snmp_enabled devices (v2c) for
    # system info, CPU/memory and interface traffic counters, and records the
    # metrics into the snmp_history hypertable.
    SNMP_ENABLED: bool = False
    SNMP_POLL_INTERVAL_SECONDS: int = 30
    SNMP_TIMEOUT_SECONDS: int = 2
    SNMP_RETRIES: int = 1

    # ── Alerting / escalation (email via SMTP) ──────────────────────────────
    ALERT_ENABLED: bool = False
    # A device must stay down at least this long before an alert is sent.
    ALERT_AFTER_SECONDS: int = 120
    # Only critical devices trigger alerts when True; all devices when False.
    ALERT_CRITICAL_ONLY: bool = True
    ALERT_CHECK_INTERVAL_SECONDS: int = 30
    # SMTP (use an internal mail relay on an air-gapped network).
    SMTP_HOST: str = ""
    SMTP_PORT: int = 25
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "netmon@example.com"
    SMTP_TLS: bool = False
    # Comma-separated recipient list.
    ALERT_EMAIL_TO: str = ""

    DEFAULT_MANAGER_EMAIL: str = "admin@example.com"
    DEFAULT_MANAGER_PASSWORD: str = "changeme"

    ENVIRONMENT: str = "development"

    @property
    def sqlalchemy_url(self) -> str:
        """Async SQLAlchemy URL for PostgreSQL via asyncpg."""
        if self.DATABASE_URL:
            return self.DATABASE_URL
        pwd = quote_plus(self.POSTGRES_PASSWORD)
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{pwd}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )


settings = Settings()
