"""Application configuration via pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(env_prefix="PQDB_")

    database_url: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/pqdb_platform"
    )
    debug: bool = False
    cors_origins: list[str] = ["*"]

    jwt_private_key_pem: str = ""
    jwt_public_key_pem: str = ""

    superuser_dsn: str = "postgresql://postgres:postgres@localhost:5432/postgres"
