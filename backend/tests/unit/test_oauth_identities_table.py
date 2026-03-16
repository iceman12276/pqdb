"""Unit tests for _pqdb_oauth_identities table creation in ensure_auth_tables."""

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.services.auth_engine import ensure_auth_tables


@pytest_asyncio.fixture
async def sqlite_session() -> AsyncIterator[AsyncSession]:
    """Create an in-memory SQLite session for unit tests."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_ensure_auth_tables_creates_oauth_identities(
    sqlite_session: AsyncSession,
) -> None:
    """ensure_auth_tables should create _pqdb_oauth_identities table."""
    await ensure_auth_tables(sqlite_session)

    # Verify the table exists by querying it
    result = await sqlite_session.execute(
        text(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name='_pqdb_oauth_identities'"
        )
    )
    row = result.fetchone()
    assert row is not None, "_pqdb_oauth_identities table was not created"


@pytest.mark.asyncio
async def test_oauth_identities_table_columns(
    sqlite_session: AsyncSession,
) -> None:
    """_pqdb_oauth_identities should have correct columns."""
    await ensure_auth_tables(sqlite_session)

    result = await sqlite_session.execute(
        text("PRAGMA table_info(_pqdb_oauth_identities)")
    )
    columns = {row[1]: row[2] for row in result.fetchall()}

    assert "id" in columns
    assert "user_id" in columns
    assert "provider" in columns
    assert "provider_uid" in columns
    assert "email" in columns
    assert "metadata" in columns
    assert "created_at" in columns


@pytest.mark.asyncio
async def test_oauth_identities_idempotent(
    sqlite_session: AsyncSession,
) -> None:
    """Calling ensure_auth_tables twice should not error."""
    await ensure_auth_tables(sqlite_session)
    await ensure_auth_tables(sqlite_session)

    result = await sqlite_session.execute(
        text("SELECT COUNT(*) FROM _pqdb_oauth_identities")
    )
    count = result.scalar()
    assert count == 0  # No rows, just the table exists
