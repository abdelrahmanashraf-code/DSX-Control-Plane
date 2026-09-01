from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="DSX_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: str = "development"
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    database_url: str = "postgresql+asyncpg://dsx:dsx@localhost:5432/dsx_control_plane"
    redis_url: str = "redis://localhost:6379/0"
    node_heartbeat_ttl_seconds: int = 90
    dev_agent_enrollment_token: str = "change-me-local-only"


@lru_cache
def get_settings() -> Settings:
    return Settings()
