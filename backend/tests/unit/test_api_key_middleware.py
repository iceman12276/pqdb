"""Unit tests for the API key middleware (FastAPI dependency)."""

import uuid

import pytest

from pqdb_api.services.api_keys import generate_api_key


class TestParseApiKeyFormat:
    """Test parsing of the pqdb_{role}_{random} key format."""

    def test_parse_anon_key_extracts_prefix(self) -> None:
        from pqdb_api.middleware.api_key import _parse_api_key

        key = generate_api_key("anon")
        prefix, role = _parse_api_key(key)
        assert prefix == key[:8]
        assert role == "anon"

    def test_parse_service_key_extracts_prefix(self) -> None:
        from pqdb_api.middleware.api_key import _parse_api_key

        key = generate_api_key("service")
        prefix, role = _parse_api_key(key)
        assert prefix == key[:8]
        assert role == "service"

    def test_parse_invalid_key_missing_prefix_raises(self) -> None:
        from pqdb_api.middleware.api_key import _parse_api_key

        with pytest.raises(ValueError, match="Invalid API key format"):
            _parse_api_key("not_a_valid_key")

    def test_parse_invalid_key_wrong_prefix_raises(self) -> None:
        from pqdb_api.middleware.api_key import _parse_api_key

        with pytest.raises(ValueError, match="Invalid API key format"):
            _parse_api_key("xxxx_anon_abcdefghijklmnopqrstuvwxyzab")

    def test_parse_empty_string_raises(self) -> None:
        from pqdb_api.middleware.api_key import _parse_api_key

        with pytest.raises(ValueError, match="Invalid API key format"):
            _parse_api_key("")


class TestProjectContext:
    """Test the ProjectContext dataclass."""

    def test_project_context_holds_values(self) -> None:
        from pqdb_api.middleware.api_key import ProjectContext

        pid = uuid.uuid4()
        ctx = ProjectContext(
            project_id=pid,
            key_role="anon",
            database_name="pqdb_project_abc123",
        )
        assert ctx.project_id == pid
        assert ctx.key_role == "anon"
        assert ctx.database_name == "pqdb_project_abc123"


class TestBuildProjectDatabaseUrl:
    """Test building a project database URL from platform URL."""

    def test_replaces_database_name(self) -> None:
        from pqdb_api.middleware.api_key import _build_project_database_url

        platform_url = "postgresql+asyncpg://postgres:postgres@localhost:5432/pqdb_platform"
        result = _build_project_database_url(platform_url, "pqdb_project_abc123")
        assert result == "postgresql+asyncpg://postgres:postgres@localhost:5432/pqdb_project_abc123"

    def test_preserves_host_and_port(self) -> None:
        from pqdb_api.middleware.api_key import _build_project_database_url

        platform_url = "postgresql+asyncpg://user:pass@db.example.com:6543/pqdb_platform"
        result = _build_project_database_url(platform_url, "pqdb_project_xyz789")
        assert "db.example.com:6543" in result
        assert result.endswith("/pqdb_project_xyz789")
