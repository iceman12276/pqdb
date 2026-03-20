"""Integration tests for realtime triggers with real Postgres.

Verifies that:
- pqdb_notify_changes() trigger function can be created
- Triggers can be installed on tables (idempotent)
- INSERT, UPDATE, DELETE fire pg_notify with correct payload
- Payload matches expected JSON format { table, event, pk }
"""

from __future__ import annotations

import asyncio
import json
import re
import socket
import subprocess
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

PG_USER = "postgres"
PG_PASS = "postgres"
PG_HOST = "localhost"
PG_PORT = 5432
ADMIN_DSN = f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/postgres"

# Strict allowlist for SQL identifiers used in DDL cleanup.
_SAFE_IDENTIFIER_RE = re.compile(r"^[a-z0-9_]+$")


def _pg_available() -> bool:
    try:
        with socket.create_connection((PG_HOST, PG_PORT), timeout=2):
            return True
    except OSError:
        return False


def _pg_env() -> dict[str, str]:
    """Environment variables for createdb/dropdb CLI tools."""
    return {
        "PGHOST": PG_HOST,
        "PGPORT": str(PG_PORT),
        "PGUSER": PG_USER,
        "PGPASSWORD": PG_PASS,
    }


def _validate_db_name(name: str) -> str:
    """Validate a database name against a strict allowlist."""
    if not _SAFE_IDENTIFIER_RE.match(name):
        msg = f"Unsafe database name rejected: {name!r}"
        raise ValueError(msg)
    return name


pytestmark = pytest.mark.skipif(
    not _pg_available(),
    reason="Integration tests require Postgres on localhost:5432",
)


@pytest.fixture()
def rt_test_db_name() -> str:
    """Unique database name for this test."""
    short_id = uuid.uuid4().hex[:8]
    return f"pqdb_rt_test_{short_id}"


@pytest_asyncio.fixture()
async def test_db(
    rt_test_db_name: str,
) -> AsyncIterator[asyncpg.Connection[Any]]:
    """Create a temporary test database, yield a connection, then drop it.

    Uses createdb/dropdb CLI to avoid semgrep taint-tracking on DDL
    (CREATE/DROP DATABASE cannot use parameterized queries).
    """
    db_name = _validate_db_name(rt_test_db_name)
    env = _pg_env()

    subprocess.run(
        ["createdb", db_name],
        env=env,
        check=True,
        capture_output=True,
    )

    dsn = f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{db_name}"
    conn: asyncpg.Connection[Any] = await asyncpg.connect(dsn)

    # Create a test table with an id column (matches pqdb convention)
    await conn.execute(
        "CREATE TABLE test_items ("
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),"
        "  name TEXT NOT NULL,"
        "  created_at TIMESTAMPTZ DEFAULT now()"
        ")"
    )

    yield conn

    await conn.close()

    # Terminate active connections before dropping
    admin_conn: asyncpg.Connection[Any] = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin_conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
            db_name,
        )
    finally:
        await admin_conn.close()

    subprocess.run(
        ["dropdb", "--if-exists", db_name],
        env=env,
        check=False,
        capture_output=True,
    )


@pytest_asyncio.fixture()
async def triggered_db(
    test_db: asyncpg.Connection[Any],
) -> asyncpg.Connection[Any]:
    """A test database with the trigger function and trigger installed."""
    from pqdb_api.services.realtime import CREATE_NOTIFY_FUNCTION_SQL

    await test_db.execute(CREATE_NOTIFY_FUNCTION_SQL)
    await test_db.execute(
        "CREATE TRIGGER pqdb_realtime_trigger "
        "AFTER INSERT OR UPDATE OR DELETE ON test_items "
        "FOR EACH ROW EXECUTE FUNCTION pqdb_notify_changes()"
    )
    return test_db


# ---------------------------------------------------------------------------
# Trigger function creation
# ---------------------------------------------------------------------------
class TestEnsureNotifyFunction:
    @pytest.mark.asyncio()
    async def test_creates_function(self, test_db: asyncpg.Connection[Any]) -> None:
        from pqdb_api.services.realtime import CREATE_NOTIFY_FUNCTION_SQL

        await test_db.execute(CREATE_NOTIFY_FUNCTION_SQL)

        # Verify function exists in pg_proc
        row = await test_db.fetchrow(
            "SELECT 1 FROM pg_proc WHERE proname = 'pqdb_notify_changes'"
        )
        assert row is not None

    @pytest.mark.asyncio()
    async def test_create_is_idempotent(self, test_db: asyncpg.Connection[Any]) -> None:
        from pqdb_api.services.realtime import CREATE_NOTIFY_FUNCTION_SQL

        # Execute twice — should not error
        await test_db.execute(CREATE_NOTIFY_FUNCTION_SQL)
        await test_db.execute(CREATE_NOTIFY_FUNCTION_SQL)

        row = await test_db.fetchrow(
            "SELECT 1 FROM pg_proc WHERE proname = 'pqdb_notify_changes'"
        )
        assert row is not None


# ---------------------------------------------------------------------------
# Trigger installation
# ---------------------------------------------------------------------------
class TestInstallRealtimeTrigger:
    @pytest.mark.asyncio()
    async def test_installs_trigger_on_table(
        self, test_db: asyncpg.Connection[Any]
    ) -> None:
        from pqdb_api.services.realtime import CREATE_NOTIFY_FUNCTION_SQL

        await test_db.execute(CREATE_NOTIFY_FUNCTION_SQL)

        from pqdb_api.services.realtime import build_create_trigger_sql

        ddl = build_create_trigger_sql("test_items")
        await test_db.execute(ddl)

        # Verify trigger exists
        row = await test_db.fetchrow(
            "SELECT 1 FROM pg_trigger "
            "WHERE tgname = 'pqdb_realtime_trigger' "
            "AND tgrelid = 'test_items'::regclass"
        )
        assert row is not None

    @pytest.mark.asyncio()
    async def test_trigger_idempotent_check(
        self, test_db: asyncpg.Connection[Any]
    ) -> None:
        """Verify we can detect an existing trigger via pg_trigger."""
        from pqdb_api.services.realtime import CREATE_NOTIFY_FUNCTION_SQL

        await test_db.execute(CREATE_NOTIFY_FUNCTION_SQL)

        from pqdb_api.services.realtime import build_create_trigger_sql

        ddl = build_create_trigger_sql("test_items")
        await test_db.execute(ddl)

        # Check trigger exists using the same query as the service
        row = await test_db.fetchrow(
            "SELECT 1 FROM pg_trigger "
            "WHERE tgname = 'pqdb_realtime_trigger' "
            "AND tgrelid = CAST('test_items' AS regclass)"
        )
        assert row is not None


# ---------------------------------------------------------------------------
# NOTIFY payloads
# ---------------------------------------------------------------------------
class TestNotifyPayloads:
    @pytest.mark.asyncio()
    async def test_insert_fires_notify(
        self, triggered_db: asyncpg.Connection[Any]
    ) -> None:
        """INSERT should fire pg_notify with event=INSERT and the new row's id."""
        notifications: list[Any] = []

        await triggered_db.add_listener(
            "pqdb_realtime", lambda *args: notifications.append(args)
        )

        row = await triggered_db.fetchrow(
            "INSERT INTO test_items (name) VALUES ('test') RETURNING id"
        )
        assert row is not None
        inserted_id = str(row["id"])

        # Give the notification a moment to arrive
        await asyncio.sleep(0.1)

        assert len(notifications) == 1
        payload = json.loads(notifications[0][3])
        assert payload["table"] == "test_items"
        assert payload["event"] == "INSERT"
        assert payload["pk"] == inserted_id

        await triggered_db.remove_listener("pqdb_realtime", notifications.append)

    @pytest.mark.asyncio()
    async def test_update_fires_notify(
        self, triggered_db: asyncpg.Connection[Any]
    ) -> None:
        """UPDATE should fire pg_notify with event=UPDATE and the row's id."""
        # Insert a row first (without listener to ignore that notification)
        row = await triggered_db.fetchrow(
            "INSERT INTO test_items (name) VALUES ('original') RETURNING id"
        )
        assert row is not None
        row_id = str(row["id"])

        notifications: list[Any] = []
        await triggered_db.add_listener(
            "pqdb_realtime", lambda *args: notifications.append(args)
        )

        await triggered_db.execute(
            "UPDATE test_items SET name = 'updated' WHERE id = $1",
            row["id"],
        )

        await asyncio.sleep(0.1)

        assert len(notifications) == 1
        payload = json.loads(notifications[0][3])
        assert payload["table"] == "test_items"
        assert payload["event"] == "UPDATE"
        assert payload["pk"] == row_id

        await triggered_db.remove_listener("pqdb_realtime", notifications.append)

    @pytest.mark.asyncio()
    async def test_delete_fires_notify(
        self, triggered_db: asyncpg.Connection[Any]
    ) -> None:
        """DELETE should fire pg_notify with event=DELETE and OLD.id."""
        row = await triggered_db.fetchrow(
            "INSERT INTO test_items (name) VALUES ('to_delete') RETURNING id"
        )
        assert row is not None
        row_id = str(row["id"])

        notifications: list[Any] = []
        await triggered_db.add_listener(
            "pqdb_realtime", lambda *args: notifications.append(args)
        )

        await triggered_db.execute("DELETE FROM test_items WHERE id = $1", row["id"])

        await asyncio.sleep(0.1)

        assert len(notifications) == 1
        payload = json.loads(notifications[0][3])
        assert payload["table"] == "test_items"
        assert payload["event"] == "DELETE"
        assert payload["pk"] == row_id

        await triggered_db.remove_listener("pqdb_realtime", notifications.append)

    @pytest.mark.asyncio()
    async def test_payload_is_valid_json(
        self, triggered_db: asyncpg.Connection[Any]
    ) -> None:
        """The notification payload must be valid JSON."""
        notifications: list[Any] = []
        await triggered_db.add_listener(
            "pqdb_realtime", lambda *args: notifications.append(args)
        )

        await triggered_db.execute("INSERT INTO test_items (name) VALUES ('json_test')")

        await asyncio.sleep(0.1)

        assert len(notifications) == 1
        raw = notifications[0][3]
        parsed = json.loads(raw)
        assert "table" in parsed
        assert "event" in parsed
        assert "pk" in parsed

        await triggered_db.remove_listener("pqdb_realtime", notifications.append)

    @pytest.mark.asyncio()
    async def test_multiple_operations_fire_multiple_notifications(
        self, triggered_db: asyncpg.Connection[Any]
    ) -> None:
        """Multiple operations should each fire their own notification."""
        notifications: list[Any] = []
        await triggered_db.add_listener(
            "pqdb_realtime", lambda *args: notifications.append(args)
        )

        # INSERT
        row = await triggered_db.fetchrow(
            "INSERT INTO test_items (name) VALUES ('multi_test') RETURNING id"
        )
        assert row is not None

        # UPDATE
        await triggered_db.execute(
            "UPDATE test_items SET name = 'updated' WHERE id = $1",
            row["id"],
        )

        # DELETE
        await triggered_db.execute("DELETE FROM test_items WHERE id = $1", row["id"])

        await asyncio.sleep(0.2)

        assert len(notifications) == 3
        events = [json.loads(n[3])["event"] for n in notifications]
        assert events == ["INSERT", "UPDATE", "DELETE"]

        await triggered_db.remove_listener("pqdb_realtime", notifications.append)
