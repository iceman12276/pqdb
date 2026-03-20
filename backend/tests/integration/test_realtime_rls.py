"""Integration tests for Realtime RLS enforcement (US-065).

Tests check_realtime_rls with real Postgres-backed column metadata
and RLS policies. Verifies the full stack: schema creation → policy
setup → event delivery decision per subscriber.
"""

from __future__ import annotations

import asyncio
import socket
import uuid
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.services.realtime_ws import check_realtime_rls
from pqdb_api.services.schema_engine import (
    ColumnDefinition,
    TableDefinition,
    create_table,
    ensure_metadata_table,
)

# ---------------------------------------------------------------------------
# Skip if Postgres is unavailable
# ---------------------------------------------------------------------------
PG_HOST = "localhost"
PG_PORT = 5432


def _pg_available() -> bool:
    try:
        with socket.create_connection((PG_HOST, PG_PORT), timeout=2):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_available(),
    reason="Integration tests require Postgres on localhost:5432",
)


# ---------------------------------------------------------------------------
# Test constants
# ---------------------------------------------------------------------------
_OWNER_USER_ID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
_OTHER_USER_ID = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _run(coro: Any) -> Any:
    """Run an async coroutine in a new event loop."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _get_column_meta(
    sf: async_sessionmaker[AsyncSession], table_name: str
) -> list[dict[str, Any]]:
    """Fetch column metadata from the real _pqdb_columns table."""
    async with sf() as session:
        await ensure_metadata_table(session)
        result = await session.execute(
            text(
                "SELECT column_name, sensitivity, data_type, is_owner "
                "FROM _pqdb_columns WHERE table_name = :name ORDER BY id"
            ),
            {"name": table_name},
        )
        return [
            {
                "name": r[0],
                "sensitivity": r[1],
                "data_type": r[2],
                "is_owner": bool(r[3]),
            }
            for r in result.fetchall()
        ]


async def _setup_auth_tables(sf: async_sessionmaker[AsyncSession]) -> None:
    """Ensure auth tables (_pqdb_roles, _pqdb_policies) exist."""
    from pqdb_api.services.auth_engine import ensure_auth_tables

    async with sf() as session:
        await ensure_auth_tables(session)


async def _create_role(sf: async_sessionmaker[AsyncSession], name: str) -> None:
    """Create a role in the _pqdb_roles table."""
    from pqdb_api.services.roles_policies import create_role

    async with sf() as session:
        try:
            await create_role(session, name)
        except ValueError:
            pass  # Already exists


async def _create_policy(
    sf: async_sessionmaker[AsyncSession],
    *,
    table_name: str,
    name: str,
    operation: str,
    role: str,
    condition: str,
) -> None:
    """Create a policy in the _pqdb_policies table."""
    from pqdb_api.services.roles_policies import (
        PolicyCondition,
        PolicyOperation,
        create_policy,
    )

    async with sf() as session:
        await create_policy(
            session,
            table_name=table_name,
            name=name,
            operation=PolicyOperation(operation),
            role=role,
            condition=PolicyCondition(condition),
        )


async def _resolve_policies(
    sf: async_sessionmaker[AsyncSession],
    table_name: str,
    user_role: str | None,
) -> list[dict[str, Any]] | None:
    """Resolve policies from the real _pqdb_policies table."""
    from pqdb_api.services.roles_policies import get_policies_for_table, lookup_policy

    async with sf() as session:
        all_policies = await get_policies_for_table(session, table_name)
        if not all_policies:
            return None

        role = user_role if user_role else "anon"
        policy = await lookup_policy(session, table_name, "select", role)
        if policy is None:
            return []
        return [policy]


async def _create_test_table(
    sf: async_sessionmaker[AsyncSession],
    name: str,
    columns: list[ColumnDefinition],
) -> None:
    """Create a table via the schema engine."""
    table_def = TableDefinition(name=name, columns=columns)
    async with sf() as session:
        await create_table(session, table_def)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def test_db_url(test_db_name: str) -> str:
    return f"postgresql+asyncpg://postgres:postgres@{PG_HOST}:{PG_PORT}/{test_db_name}"


@pytest.fixture()
def sf(test_db_url: str) -> async_sessionmaker[AsyncSession]:
    engine = create_async_engine(test_db_url)
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestRealtimeRlsWithRealDb:
    """Integration tests: check_realtime_rls with real DB metadata."""

    def test_no_policies_no_owner_open_access(
        self, sf: async_sessionmaker[AsyncSession]
    ) -> None:
        """No policies + no owner column = all roles receive (Phase 1)."""

        async def _run_test() -> None:
            await _create_test_table(sf, "notes", [
                ColumnDefinition(name="content", data_type="text", sensitivity="plain"),
            ])
            cols = await _get_column_meta(sf, "notes")
            await _setup_auth_tables(sf)
            policies = await _resolve_policies(sf, "notes", None)

            assert policies is None
            assert check_realtime_rls(
                row={"id": "1", "content": "hello"},
                key_role="anon",
                user_id=None,
                user_role=None,
                columns_meta=cols,
                policies=policies,
            ) is True

        _run(_run_test())

    def test_owner_column_basic_rls(
        self, sf: async_sessionmaker[AsyncSession]
    ) -> None:
        """Owner column present, no policies = basic owner-column RLS."""

        async def _run_test() -> None:
            await _create_test_table(sf, "todos", [
                ColumnDefinition(
                    name="user_id", data_type="uuid",
                    sensitivity="plain", is_owner=True,
                ),
                ColumnDefinition(name="task", data_type="text", sensitivity="plain"),
            ])
            cols = await _get_column_meta(sf, "todos")
            await _setup_auth_tables(sf)
            policies = await _resolve_policies(sf, "todos", None)

            assert policies is None

            row = {"id": "1", "user_id": str(_OWNER_USER_ID), "task": "mine"}

            # Owner receives
            assert check_realtime_rls(
                row=row, key_role="anon", user_id=_OWNER_USER_ID,
                user_role=None, columns_meta=cols, policies=policies,
            ) is True

            # Non-owner denied
            assert check_realtime_rls(
                row=row, key_role="anon", user_id=_OTHER_USER_ID,
                user_role=None, columns_meta=cols, policies=policies,
            ) is False

            # Service role bypasses
            assert check_realtime_rls(
                row=row, key_role="service", user_id=None,
                user_role=None, columns_meta=cols, policies=policies,
            ) is True

        _run(_run_test())

    def test_policy_all_delivers(
        self, sf: async_sessionmaker[AsyncSession]
    ) -> None:
        """Policy condition=all: deliver to everyone."""

        async def _run_test() -> None:
            await _create_test_table(sf, "announcements", [
                ColumnDefinition(name="message", data_type="text", sensitivity="plain"),
            ])
            await _setup_auth_tables(sf)
            await _create_role(sf, "authenticated")
            await _create_policy(
                sf, table_name="announcements", name="allow_read",
                operation="select", role="authenticated", condition="all",
            )

            cols = await _get_column_meta(sf, "announcements")
            policies = await _resolve_policies(sf, "announcements", "authenticated")

            assert policies is not None and len(policies) == 1

            assert check_realtime_rls(
                row={"id": "1", "message": "hi"},
                key_role="anon", user_id=_OTHER_USER_ID,
                user_role="authenticated", columns_meta=cols, policies=policies,
            ) is True

        _run(_run_test())

    def test_policy_none_denies(
        self, sf: async_sessionmaker[AsyncSession]
    ) -> None:
        """Policy condition=none: deny delivery."""

        async def _run_test() -> None:
            await _create_test_table(sf, "secrets", [
                ColumnDefinition(name="data", data_type="text", sensitivity="plain"),
            ])
            await _setup_auth_tables(sf)
            await _create_role(sf, "authenticated")
            await _create_policy(
                sf, table_name="secrets", name="deny_read",
                operation="select", role="authenticated", condition="none",
            )

            cols = await _get_column_meta(sf, "secrets")
            policies = await _resolve_policies(sf, "secrets", "authenticated")

            assert policies is not None

            # Deny for authenticated user
            assert check_realtime_rls(
                row={"id": "1", "data": "classified"},
                key_role="anon", user_id=_OWNER_USER_ID,
                user_role="authenticated", columns_meta=cols, policies=policies,
            ) is False

            # Service role still receives
            assert check_realtime_rls(
                row={"id": "1", "data": "classified"},
                key_role="service", user_id=None,
                user_role=None, columns_meta=cols, policies=policies,
            ) is True

        _run(_run_test())

    def test_policy_owner_filters_by_ownership(
        self, sf: async_sessionmaker[AsyncSession]
    ) -> None:
        """Policy condition=owner: deliver only to row owner."""

        async def _run_test() -> None:
            await _create_test_table(sf, "messages", [
                ColumnDefinition(
                    name="user_id", data_type="uuid",
                    sensitivity="plain", is_owner=True,
                ),
                ColumnDefinition(name="body", data_type="text", sensitivity="plain"),
            ])
            await _setup_auth_tables(sf)
            await _create_role(sf, "authenticated")
            await _create_policy(
                sf, table_name="messages", name="owner_read",
                operation="select", role="authenticated", condition="owner",
            )

            cols = await _get_column_meta(sf, "messages")
            policies = await _resolve_policies(sf, "messages", "authenticated")

            row = {"id": "1", "user_id": str(_OWNER_USER_ID), "body": "private"}

            # Owner receives
            assert check_realtime_rls(
                row=row, key_role="anon", user_id=_OWNER_USER_ID,
                user_role="authenticated", columns_meta=cols, policies=policies,
            ) is True

            # Non-owner denied
            assert check_realtime_rls(
                row=row, key_role="anon", user_id=_OTHER_USER_ID,
                user_role="authenticated", columns_meta=cols, policies=policies,
            ) is False

        _run(_run_test())

    def test_no_matching_policy_denies(
        self, sf: async_sessionmaker[AsyncSession]
    ) -> None:
        """Policies exist for table but not for this role/op = deny."""

        async def _run_test() -> None:
            await _create_test_table(sf, "logs", [
                ColumnDefinition(name="entry", data_type="text", sensitivity="plain"),
            ])
            await _setup_auth_tables(sf)

            # Policy for "admin" role only
            await _create_role(sf, "admin")
            await _create_policy(
                sf, table_name="logs", name="admin_read",
                operation="select", role="admin", condition="all",
            )

            cols = await _get_column_meta(sf, "logs")
            # Query as "authenticated" — no matching policy
            await _create_role(sf, "authenticated")
            policies = await _resolve_policies(sf, "logs", "authenticated")

            assert policies is not None and len(policies) == 0

            assert check_realtime_rls(
                row={"id": "1", "entry": "something"},
                key_role="anon", user_id=_OWNER_USER_ID,
                user_role="authenticated", columns_meta=cols, policies=policies,
            ) is False

        _run(_run_test())
