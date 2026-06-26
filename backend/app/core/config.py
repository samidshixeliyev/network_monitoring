from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Look for .env both in the project root (when running from backend/) and in
    # the current dir. A later file overrides an earlier one. OS env vars (e.g.
    # injected by docker-compose) always take precedence over both.
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    # ── MSSQL connection parts ──────────────────────────────────────────────
    # Edit these in .env. They are assembled into an aioodbc connection string.
    # A named instance like  localhost\SQLEXPRESS  works as-is here (the
    # odbc_connect form avoids URL-escaping headaches with the backslash).
    MSSQL_SERVER: str = r"localhost\SQLEXPRESS"
    MSSQL_DATABASE: str = "network"
    MSSQL_USER: str = "sa"
    MSSQL_PASSWORD: str = "changeme"
    MSSQL_DRIVER: str = "ODBC Driver 17 for SQL Server"
    MSSQL_ENCRYPT: str = "yes"
    MSSQL_TRUST_CERT: str = "yes"

    # Optional full override. If set, it is used verbatim and the parts above
    # are ignored (e.g. to point at a different driver/host entirely).
    DATABASE_URL: str | None = None

    SECRET_KEY: str = "change-this-secret"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    PING_INTERVAL_SECONDS: int = 30
    # ICMP packets sent per check. Long network paths can drop some packets, so
    # the device counts as alive if AT LEAST ONE of these replies.
    PING_COUNT: int = 3
    # Consecutive fully-failed checks before a device flips OFFLINE. The first
    # failed check moves it to UNKNOWN (yellow); reaching this count → OFFLINE.
    FLAP_THRESHOLD: int = 2
    PING_TIMEOUT_SECONDS: int = 1

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

    DEFAULT_MANAGER_EMAIL: str = "admin@example.com"
    DEFAULT_MANAGER_PASSWORD: str = "changeme"

    ENVIRONMENT: str = "development"

    @property
    def sqlalchemy_url(self) -> str:
        """Async SQLAlchemy URL for SQL Server via aioodbc."""
        if self.DATABASE_URL:
            return self.DATABASE_URL
        odbc = (
            f"DRIVER={{{self.MSSQL_DRIVER}}};"
            f"SERVER={self.MSSQL_SERVER};"
            f"DATABASE={self.MSSQL_DATABASE};"
            f"UID={self.MSSQL_USER};"
            f"PWD={self.MSSQL_PASSWORD};"
            f"Encrypt={self.MSSQL_ENCRYPT};"
            f"TrustServerCertificate={self.MSSQL_TRUST_CERT};"
        )
        return f"mssql+aioodbc:///?odbc_connect={quote_plus(odbc)}"


settings = Settings()
