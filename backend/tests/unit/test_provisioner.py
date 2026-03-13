"""Unit tests for the database provisioner service."""

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from pqdb_api.services.provisioner import (
    DatabaseProvisioner,
    ProvisioningError,
    _validate_identifier,
    make_database_name,
    make_project_user,
)


class TestMakeDatabaseName:
    """Tests for the database naming function."""

    def test_starts_with_pqdb_project(self) -> None:
        project_id = uuid.uuid4()
        name = make_database_name(project_id)
        assert name.startswith("pqdb_project_")

    def test_uses_short_uuid(self) -> None:
        project_id = uuid.uuid4()
        name = make_database_name(project_id)
        suffix = name.removeprefix("pqdb_project_")
        # Short UUID = first 12 chars of hex, no dashes
        assert len(suffix) == 12
        assert "-" not in suffix

    def test_deterministic(self) -> None:
        project_id = uuid.uuid4()
        assert make_database_name(project_id) == make_database_name(project_id)

    def test_different_projects_different_names(self) -> None:
        id_a = uuid.uuid4()
        id_b = uuid.uuid4()
        assert make_database_name(id_a) != make_database_name(id_b)


class TestMakeProjectUser:
    """Tests for the project user naming function."""

    def test_starts_with_pqdb_user(self) -> None:
        project_id = uuid.uuid4()
        user = make_project_user(project_id)
        assert user.startswith("pqdb_user_")

    def test_deterministic(self) -> None:
        project_id = uuid.uuid4()
        assert make_project_user(project_id) == make_project_user(project_id)


class TestValidateIdentifier:
    """Tests for the SQL identifier validator."""

    def test_accepts_valid_identifier(self) -> None:
        result = _validate_identifier("pqdb_project_abc123def456")
        assert result == "pqdb_project_abc123def456"

    def test_rejects_semicolon(self) -> None:
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("name; DROP TABLE--")

    def test_rejects_quotes(self) -> None:
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier('name"injection')

    def test_rejects_uppercase(self) -> None:
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("PQDB_PROJECT_ABC")

    def test_rejects_spaces(self) -> None:
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("name with spaces")

    def test_rejects_empty_string(self) -> None:
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("")


class TestDatabaseProvisioner:
    """Tests for the DatabaseProvisioner class."""

    def test_init_stores_dsn(self) -> None:
        dsn = "postgresql://postgres:postgres@localhost:5432/postgres"
        provisioner = DatabaseProvisioner(superuser_dsn=dsn)
        assert provisioner.superuser_dsn == dsn

    @pytest.mark.asyncio()
    async def test_provision_calls_create_database(self) -> None:
        dsn = "postgresql://postgres:postgres@localhost:5432/postgres"
        provisioner = DatabaseProvisioner(superuser_dsn=dsn)
        project_id = uuid.uuid4()
        db_name = make_database_name(project_id)

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
        ) as mock_connect:
            mock_connect.return_value = mock_conn
            result = await provisioner.provision(project_id)

        assert result == db_name
        # Verify CREATE USER, CREATE DATABASE, and GRANT were called
        calls = [str(c) for c in mock_conn.execute.call_args_list]
        call_str = " ".join(calls)
        assert "CREATE USER" in call_str
        assert "CREATE DATABASE" in call_str
        assert "GRANT" in call_str

    @pytest.mark.asyncio()
    async def test_provision_raises_provisioning_error_on_failure(self) -> None:
        dsn = "postgresql://postgres:postgres@localhost:5432/postgres"
        provisioner = DatabaseProvisioner(superuser_dsn=dsn)
        project_id = uuid.uuid4()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
        ) as mock_connect:
            mock_connect.side_effect = Exception("Connection refused")
            with pytest.raises(ProvisioningError, match="Connection refused"):
                await provisioner.provision(project_id)

    @pytest.mark.asyncio()
    async def test_provision_closes_connection_on_success(self) -> None:
        dsn = "postgresql://postgres:postgres@localhost:5432/postgres"
        provisioner = DatabaseProvisioner(superuser_dsn=dsn)
        project_id = uuid.uuid4()

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
        ) as mock_connect:
            mock_connect.return_value = mock_conn
            await provisioner.provision(project_id)

        mock_conn.close.assert_awaited_once()

    @pytest.mark.asyncio()
    async def test_provision_closes_connection_on_failure(self) -> None:
        dsn = "postgresql://postgres:postgres@localhost:5432/postgres"
        provisioner = DatabaseProvisioner(superuser_dsn=dsn)
        project_id = uuid.uuid4()

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(side_effect=Exception("SQL error"))
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
        ) as mock_connect:
            mock_connect.return_value = mock_conn
            with pytest.raises(ProvisioningError):
                await provisioner.provision(project_id)

        mock_conn.close.assert_awaited_once()
