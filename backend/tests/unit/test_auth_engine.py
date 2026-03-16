"""Unit tests for auth_engine service.

Tests the SQL generation, ensure_auth_tables idempotency,
and settings CRUD functions using in-memory SQLite.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.services.auth_engine import (
    AuthEngineError,
    ensure_auth_tables,
    get_auth_settings,
    update_auth_settings,
)


@pytest.fixture()
def engine():  # type: ignore[no-untyped-def]
    """Create an in-memory SQLite engine."""
    return create_async_engine("sqlite+aiosqlite://", echo=False)


@pytest.fixture()
def session_factory(engine):  # type: ignore[no-untyped-def]
    """Create a session factory."""
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class TestEnsureAuthTables:
    """Tests for ensure_auth_tables() DDL creation."""

    @pytest.mark.asyncio()
    async def test_creates_users_table(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(
                text(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name='_pqdb_users'"
                )
            )
            assert result.scalar() == "_pqdb_users"

    @pytest.mark.asyncio()
    async def test_creates_sessions_table(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(
                text(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name='_pqdb_sessions'"
                )
            )
            assert result.scalar() == "_pqdb_sessions"

    @pytest.mark.asyncio()
    async def test_creates_auth_settings_table(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(
                text(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name='_pqdb_auth_settings'"
                )
            )
            assert result.scalar() == "_pqdb_auth_settings"

    @pytest.mark.asyncio()
    async def test_idempotent_call(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Calling ensure_auth_tables twice should not raise."""
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await ensure_auth_tables(session)
            result = await session.execute(
                text(
                    "SELECT count(*) FROM sqlite_master "
                    "WHERE type='table' AND name LIKE '_pqdb_%'"
                )
            )
            count = result.scalar()
            # _pqdb_users, _pqdb_sessions, _pqdb_auth_settings,
            # _pqdb_mfa_factors, _pqdb_recovery_codes
            assert count == 5

    @pytest.mark.asyncio()
    async def test_users_table_columns(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Verify _pqdb_users has the expected columns."""
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(text("PRAGMA table_info(_pqdb_users)"))
            columns = {row[1] for row in result.fetchall()}
            expected = {
                "id",
                "email",
                "password_hash",
                "role",
                "email_verified",
                "metadata",
                "created_at",
                "updated_at",
            }
            assert expected.issubset(columns)

    @pytest.mark.asyncio()
    async def test_sessions_table_columns(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Verify _pqdb_sessions has the expected columns."""
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(text("PRAGMA table_info(_pqdb_sessions)"))
            columns = {row[1] for row in result.fetchall()}
            expected = {
                "id",
                "user_id",
                "refresh_token_hash",
                "expires_at",
                "revoked",
                "created_at",
            }
            assert expected.issubset(columns)

    @pytest.mark.asyncio()
    async def test_auth_settings_default_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """ensure_auth_tables should insert a default settings row."""
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(
                text("SELECT count(*) FROM _pqdb_auth_settings")
            )
            assert result.scalar() == 1


class TestGetAuthSettings:
    """Tests for get_auth_settings()."""

    @pytest.mark.asyncio()
    async def test_returns_defaults(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            settings = await get_auth_settings(session)
            assert settings["require_email_verification"] is False
            assert settings["magic_link_webhook"] is None
            assert settings["password_min_length"] == 8
            assert settings["mfa_enabled"] is False

    @pytest.mark.asyncio()
    async def test_returns_defaults_before_explicit_init(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """get_auth_settings should init tables if they don't exist yet."""
        async with session_factory() as session:
            settings = await get_auth_settings(session)
            assert settings is not None
            assert settings["password_min_length"] == 8

    @pytest.mark.asyncio()
    async def test_raises_runtime_error_when_row_missing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """get_auth_settings raises RuntimeError if settings row is missing."""
        from unittest.mock import AsyncMock, patch

        async with session_factory() as session:
            await ensure_auth_tables(session)
            # Delete the settings row to simulate corruption
            await session.execute(text("DELETE FROM _pqdb_auth_settings"))
            await session.commit()
            # Patch ensure_auth_tables to no-op so it doesn't re-insert the row
            with patch(
                "pqdb_api.services.auth_engine.ensure_auth_tables",
                new_callable=AsyncMock,
            ):
                with pytest.raises(RuntimeError, match="Auth settings row missing"):
                    await get_auth_settings(session)


class TestAuthEngineError:
    """Tests for AuthEngineError exception class."""

    def test_auth_engine_error_is_exception(self) -> None:
        err = AuthEngineError("test")
        assert isinstance(err, Exception)
        assert str(err) == "test"


class TestUpdateAuthSettings:
    """Tests for update_auth_settings()."""

    @pytest.mark.asyncio()
    async def test_update_single_field(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            updated = await update_auth_settings(session, {"password_min_length": 12})
            assert updated["password_min_length"] == 12
            assert updated["require_email_verification"] is False

    @pytest.mark.asyncio()
    async def test_update_multiple_fields(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            updated = await update_auth_settings(
                session,
                {
                    "require_email_verification": True,
                    "mfa_enabled": True,
                    "magic_link_webhook": "https://example.com/hook",
                },
            )
            assert updated["require_email_verification"] is True
            assert updated["mfa_enabled"] is True
            assert updated["magic_link_webhook"] == "https://example.com/hook"

    @pytest.mark.asyncio()
    async def test_update_rejects_unknown_field(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="Unknown auth setting"):
                await update_auth_settings(session, {"nonexistent_field": True})

    @pytest.mark.asyncio()
    async def test_update_persists(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Updated settings should be readable afterwards."""
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await update_auth_settings(session, {"password_min_length": 16})
            settings = await get_auth_settings(session)
            assert settings["password_min_length"] == 16
