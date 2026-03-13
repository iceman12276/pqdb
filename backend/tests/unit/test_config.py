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
