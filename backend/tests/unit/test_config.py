"""Unit tests for application configuration."""

import pytest

from pqdb_api.config import Settings


def test_settings_defaults() -> None:
    settings = Settings()
    assert "postgresql+asyncpg" in settings.database_url
    assert settings.debug is False


def test_settings_env_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "PQDB_DATABASE_URL", "postgresql+asyncpg://test:test@testhost/testdb"
    )
    settings = Settings()
    assert settings.database_url == "postgresql+asyncpg://test:test@testhost/testdb"


def test_settings_debug_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PQDB_DEBUG", "true")
    settings = Settings()
    assert settings.debug is True


def test_settings_vault_defaults() -> None:
    settings = Settings()
    assert settings.vault_addr == "http://localhost:8200"
    assert settings.vault_token == "dev-root-token"


def test_settings_vault_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PQDB_VAULT_ADDR", "http://vault:8200")
    monkeypatch.setenv("PQDB_VAULT_TOKEN", "custom-token")
    settings = Settings()
    assert settings.vault_addr == "http://vault:8200"
    assert settings.vault_token == "custom-token"


def test_settings_cors_origins_include_https() -> None:
    settings = Settings()
    assert "https://localhost" in settings.cors_origins
    assert "http://localhost:3000" in settings.cors_origins


def test_settings_webauthn_origin_is_https() -> None:
    settings = Settings()
    assert settings.webauthn_origin == "https://localhost"


def test_settings_webauthn_origin_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PQDB_WEBAUTHN_ORIGIN", "https://myapp.example.com")
    settings = Settings()
    assert settings.webauthn_origin == "https://myapp.example.com"


def test_settings_allowed_redirect_uris_include_https() -> None:
    settings = Settings()
    uris = settings.allowed_redirect_uris
    assert "https://localhost" in uris
    assert "http://localhost:3000" in uris


def test_settings_cors_origins_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PQDB_CORS_ORIGINS", '["https://myapp.com"]')
    settings = Settings()
    assert settings.cors_origins == ["https://myapp.com"]
