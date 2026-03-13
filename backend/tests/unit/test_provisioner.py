"""Unit tests for the database provisioner service."""

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from pqdb_api.services.provisioner import (
    ProvisionResult,
    generate_db_name,
    generate_db_user,
    provision_database,
)


class TestGenerateDbName:
    """Tests for database name generation."""

    def test_starts_with_prefix(self) -> None:
        project_id = uuid.uuid4()
        name = generate_db_name(project_id)
        assert name.startswith("pqdb_project_")

    def test_uses_short_uuid(self) -> None:
        project_id = uuid.uuid4()
        name = generate_db_name(project_id)
        suffix = name.removeprefix("pqdb_project_")
        assert suffix == project_id.hex[:12]

    def test_deterministic(self) -> None:
        project_id = uuid.uuid4()
        assert generate_db_name(project_id) == generate_db_name(project_id)

    def test_different_projects_get_different_names(self) -> None:
        name_a = generate_db_name(uuid.uuid4())
        name_b = generate_db_name(uuid.uuid4())
        assert name_a != name_b


class TestGenerateDbUser:
    """Tests for database user generation."""

    def test_starts_with_prefix(self) -> None:
        project_id = uuid.uuid4()
        user = generate_db_user(project_id)
        assert user.startswith("pqdb_user_")

    def test_uses_short_uuid(self) -> None:
        project_id = uuid.uuid4()
        user = generate_db_user(project_id)
        suffix = user.removeprefix("pqdb_user_")
        assert suffix == project_id.hex[:12]


class TestProvisionResult:
    """Tests for ProvisionResult dataclass."""

    def test_has_required_fields(self) -> None:
        result = ProvisionResult(
            database_name="pqdb_project_abc123def456",
            database_user="pqdb_user_abc123def456",
        )
        assert result.database_name == "pqdb_project_abc123def456"
        assert result.database_user == "pqdb_user_abc123def456"


class TestProvisionDatabase:
    """Tests for the provision_database function."""

    @pytest.mark.asyncio
    async def test_returns_provision_result(self) -> None:
        project_id = uuid.uuid4()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
            return_value=mock_conn,
        ):
            result = await provision_database(
                project_id, "postgresql://user:pass@localhost/db"
            )

        assert isinstance(result, ProvisionResult)
        expected_db = generate_db_name(project_id)
        assert result.database_name == expected_db

    @pytest.mark.asyncio
    async def test_creates_database_and_user(self) -> None:
        project_id = uuid.uuid4()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
            return_value=mock_conn,
        ):
            await provision_database(project_id, "postgresql://user:pass@localhost/db")

        calls = [str(c) for c in mock_conn.execute.call_args_list]
        call_text = " ".join(calls)
        assert "CREATE USER" in call_text or "CREATE ROLE" in call_text
        assert "CREATE DATABASE" in call_text

    @pytest.mark.asyncio
    async def test_grants_privileges(self) -> None:
        project_id = uuid.uuid4()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
            return_value=mock_conn,
        ):
            await provision_database(project_id, "postgresql://user:pass@localhost/db")

        calls = [str(c) for c in mock_conn.execute.call_args_list]
        call_text = " ".join(calls)
        assert "GRANT" in call_text

    @pytest.mark.asyncio
    async def test_closes_connection(self) -> None:
        project_id = uuid.uuid4()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
            return_value=mock_conn,
        ):
            await provision_database(project_id, "postgresql://user:pass@localhost/db")

        mock_conn.close.assert_awaited()

    @pytest.mark.asyncio
    async def test_closes_connection_on_error(self) -> None:
        project_id = uuid.uuid4()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(side_effect=Exception("db error"))
        mock_conn.close = AsyncMock()

        with (
            patch(
                "pqdb_api.services.provisioner.asyncpg.connect",
                new_callable=AsyncMock,
                return_value=mock_conn,
            ),
            pytest.raises(Exception, match="db error"),
        ):
            await provision_database(project_id, "postgresql://user:pass@localhost/db")

        mock_conn.close.assert_awaited()

    @pytest.mark.asyncio
    async def test_converts_sqlalchemy_url_to_asyncpg(self) -> None:
        project_id = uuid.uuid4()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.provisioner.asyncpg.connect",
            new_callable=AsyncMock,
            return_value=mock_conn,
        ) as mock_connect:
            await provision_database(
                project_id,
                "postgresql+asyncpg://user:pass@localhost:5432/db",
            )

        dsn = mock_connect.call_args[0][0]
        assert "+asyncpg" not in dsn
