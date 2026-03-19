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

    vault_addr: str = "http://localhost:8200"
    vault_token: str = "dev-root-token"

    # Rate limiting (requests per minute)
    rate_limit_crud: int = 1000  # per project, /v1/db/* endpoints
    rate_limit_auth: int = 20  # per IP, /v1/auth/signup, login, refresh

    # OAuth redirect URI allowlist (comma-separated origins)
    allowed_redirect_uris_raw: str = "http://localhost:3000"

    # WebAuthn / Passkey settings
    webauthn_rp_id: str = "localhost"
    webauthn_rp_name: str = "pqdb"
    webauthn_origin: str = "http://localhost:3000"

    @property
    def allowed_redirect_uris(self) -> list[str]:
        parts = self.allowed_redirect_uris_raw.split(",")
        return [u.strip() for u in parts if u.strip()]
