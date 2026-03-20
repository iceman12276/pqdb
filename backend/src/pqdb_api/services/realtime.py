"""Realtime trigger management for project databases.

Installs PostgreSQL triggers that fire pg_notify('pqdb_realtime', ...)
on INSERT, UPDATE, and DELETE. The notification payload contains only
the table name, event type, and primary key (id column) to stay well
under the pg_notify 8 KB limit.

Each project database has its own pqdb_realtime channel — isolation
is achieved by database separation.
"""

from __future__ import annotations

import json
import re

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

_VALID_IDENTIFIER_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# ---------------------------------------------------------------------------
# SQL: trigger function (created once per project database)
# ---------------------------------------------------------------------------
# nosemgrep: avoid-sqlalchemy-text
CREATE_NOTIFY_FUNCTION_SQL = """\
CREATE OR REPLACE FUNCTION pqdb_notify_changes()
RETURNS trigger AS $$
DECLARE
    payload json;
    pk text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        pk := OLD.id::text;
    ELSE
        pk := NEW.id::text;
    END IF;

    payload := json_build_object(
        'table', TG_TABLE_NAME,
        'event', TG_OP,
        'pk', pk
    );

    PERFORM pg_notify('pqdb_realtime', payload::text);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;
"""

# ---------------------------------------------------------------------------
# SQL: check whether trigger already exists on a table
# ---------------------------------------------------------------------------
_CHECK_TRIGGER_SQL = text(
    "SELECT 1 FROM pg_trigger "
    "WHERE tgname = 'pqdb_realtime_trigger' "
    "AND tgrelid = CAST(:table_name AS regclass)"
)

# ---------------------------------------------------------------------------
# SQL template for creating a trigger on a specific table.
# The table name is validated against a strict allowlist regex
# before interpolation — it cannot come from user input unvalidated.
# ---------------------------------------------------------------------------
_CREATE_TRIGGER_TEMPLATE = (
    "CREATE TRIGGER pqdb_realtime_trigger "
    "AFTER INSERT OR UPDATE OR DELETE ON {table} "
    "FOR EACH ROW EXECUTE FUNCTION pqdb_notify_changes()"
)


def _validate_identifier(name: str) -> str:
    """Validate a SQL identifier against a strict allowlist.

    Raises ValueError if the name does not match ^[a-z][a-z0-9_]*$.
    """
    if not _VALID_IDENTIFIER_RE.match(name):
        msg = f"Invalid table name: {name!r}"
        raise ValueError(msg)
    return name


def build_create_trigger_sql(table_name: str) -> str:
    """Build the CREATE TRIGGER DDL for a validated table name.

    The table name is validated before interpolation to prevent
    SQL injection. Returns raw SQL string.
    """
    safe_name = _validate_identifier(table_name)
    return _CREATE_TRIGGER_TEMPLATE.format(table=safe_name)


def build_notify_payload(table: str, event: str, pk: str) -> str:
    """Build the JSON payload that pqdb_notify_changes() would emit.

    Useful for testing expected payload format.
    """
    return json.dumps({"table": table, "event": event, "pk": pk})


async def ensure_notify_function(session: AsyncSession) -> None:
    """Create or replace the pqdb_notify_changes() trigger function."""
    await session.execute(text(CREATE_NOTIFY_FUNCTION_SQL))
    await session.commit()
    logger.info("realtime.notify_function_ensured")


async def install_realtime_trigger(table_name: str, session: AsyncSession) -> bool:
    """Install the realtime trigger on a table (idempotent).

    Returns True if the trigger was newly created, False if it
    already existed.
    """
    safe_name = _validate_identifier(table_name)

    # Check if trigger already exists
    result = await session.execute(_CHECK_TRIGGER_SQL, {"table_name": safe_name})
    if result.scalar() is not None:
        logger.info(
            "realtime.trigger_already_exists",
            table=safe_name,
        )
        return False

    # Ensure the trigger function exists
    await session.execute(text(CREATE_NOTIFY_FUNCTION_SQL))

    # Create the trigger
    ddl = build_create_trigger_sql(safe_name)
    await session.execute(text(ddl))
    await session.commit()

    logger.info("realtime.trigger_installed", table=safe_name)
    return True
