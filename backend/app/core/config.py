from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql+asyncpg://netmon:changeme@postgres:5432/netmon"
    SECRET_KEY: str = "change-this-secret"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    PING_INTERVAL_SECONDS: int = 30
    FLAP_THRESHOLD: int = 3

    DEFAULT_MANAGER_EMAIL: str = "admin@example.com"
    DEFAULT_MANAGER_PASSWORD: str = "changeme"

    ENVIRONMENT: str = "development"


settings = Settings()
