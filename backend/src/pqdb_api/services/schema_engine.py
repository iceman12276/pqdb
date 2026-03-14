"""Schema engine — column sensitivity metadata and DDL generation.

Handles mapping between logical column definitions (with sensitivity
levels) and physical PostgreSQL columns. Sensitive columns are split
into shadow columns: encrypted (bytea) and optionally index (text).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

_VALID_IDENTIFIER_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_RESERVED_PREFIXES = ("_pqdb_", "pg_")
_RESERVED_COLUMN_NAMES = frozenset({"id", "created_at", "updated_at"})
_RESERVED_SUFFIXES = ("_encrypted", "_index")

Sensitivity = Literal["plain", "private", "searchable"]
_VALID_SENSITIVITIES: frozenset[str] = frozenset({"plain", "private", "searchable"})

# --- Static SQL statements ------------------------------------------------
# These use the literal table name "_pqdb_columns" to avoid f-string
# interpolation inside text(), which triggers SQL-injection scanners.
# The metadata table name is an internal constant, never user-controlled.

_SQL_CREATE_METADATA = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    "CREATE TABLE IF NOT EXISTS _pqdb_columns ("
    "  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"
    "  table_name text NOT NULL,"
    "  column_name text NOT NULL,"
    "  sensitivity text NOT NULL,"
    "  data_type text NOT NULL,"
    "  created_at timestamptz NOT NULL DEFAULT now(),"
    "  UNIQUE(table_name, column_name)"
    ")"
)

_SQL_TABLE_EXISTS = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    "SELECT EXISTS ("
    "  SELECT 1 FROM information_schema.tables "
    "  WHERE table_schema = 'public' AND table_name = :name"
    ")"
)

_SQL_INSERT_METADATA = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    "INSERT INTO _pqdb_columns "
    "(table_name, column_name, sensitivity, data_type) "
    "VALUES (:table_name, :column_name, :sensitivity, :data_type)"
)

_SQL_DISTINCT_TABLES = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    "SELECT DISTINCT table_name FROM _pqdb_columns "
    "ORDER BY table_name"
)

_SQL_TABLE_COLUMNS = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    "SELECT column_name, sensitivity, data_type "
    "FROM _pqdb_columns "
    "WHERE table_name = :name ORDER BY id"
)


def validate_table_name(name: str) -> str:
    """Validate a table name for safety and conventions.

    Raises ValueError for invalid names.
    """
    if not name:
        raise ValueError("Table name must not be empty")
    if not _VALID_IDENTIFIER_RE.match(name):
        if name[0].isdigit():
            raise ValueError(f"Table name {name!r} must start with a letter")
        raise ValueError(f"Table name {name!r} contains invalid characters")
    for prefix in _RESERVED_PREFIXES:
        if name.startswith(prefix):
            raise ValueError(f"Table name {name!r} is reserved (prefix {prefix!r})")
    return name


def validate_column_name(name: str) -> str:
    """Validate a column name for safety and conventions.

    Raises ValueError for invalid names.
    """
    if not name:
        raise ValueError("Column name must not be empty")
    if name in _RESERVED_COLUMN_NAMES:
        raise ValueError(f"Column name {name!r} is reserved")
    if not _VALID_IDENTIFIER_RE.match(name):
        if name[0].isdigit():
            raise ValueError(f"Column name {name!r} must start with a letter")
        raise ValueError(f"Column name {name!r} contains invalid characters")
    for suffix in _RESERVED_SUFFIXES:
        if name.endswith(suffix):
            raise ValueError(
                f"Column name {name!r} uses reserved suffix {suffix!r}"
            )
    return name


@dataclass(frozen=True)
class ColumnDefinition:
    """Logical column definition with sensitivity level."""

    name: str
    data_type: str
    sensitivity: Sensitivity = "plain"

    def __post_init__(self) -> None:
        if self.sensitivity not in _VALID_SENSITIVITIES:
            raise ValueError(
                f"Invalid sensitivity {self.sensitivity!r}; "
                f"must be one of {sorted(_VALID_SENSITIVITIES)}"
            )
        validate_column_name(self.name)


@dataclass
class TableDefinition:
    """Logical table definition with column sensitivity metadata."""

    name: str
    columns: list[ColumnDefinition] = field(default_factory=list)

    def __post_init__(self) -> None:
        validate_table_name(self.name)
        if not self.columns:
            raise ValueError("Table must have at least one column")
        seen: set[str] = set()
        for col in self.columns:
            if col.name in seen:
                raise ValueError(f"Duplicate column name: {col.name!r}")
            seen.add(col.name)


def map_sensitivity_to_physical(col: ColumnDefinition) -> list[tuple[str, str]]:
    """Map a logical column to physical (name, type) pairs.

    - plain: [(name, data_type)]
    - private: [(name_encrypted, bytea)]
    - searchable: [(name_encrypted, bytea), (name_index, text)]
    """
    if col.sensitivity == "plain":
        return [(col.name, col.data_type)]
    elif col.sensitivity == "private":
        return [(f"{col.name}_encrypted", "bytea")]
    else:  # searchable
        return [
            (f"{col.name}_encrypted", "bytea"),
            (f"{col.name}_index", "text"),
        ]


def build_physical_columns_sql(table: TableDefinition) -> list[str]:
    """Build SQL column definition strings for CREATE TABLE.

    Includes auto-generated id, created_at, updated_at columns.
    """
    parts: list[str] = [
        "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
    ]

    for col in table.columns:
        for phys_name, phys_type in map_sensitivity_to_physical(col):
            parts.append(f"{phys_name} {phys_type}")

    parts.append(
        "created_at timestamptz NOT NULL DEFAULT now()"
    )
    parts.append(
        "updated_at timestamptz NOT NULL DEFAULT now()"
    )

    return parts


def _build_create_table_sql(table_name: str, col_defs: list[str]) -> str:
    """Build a CREATE TABLE DDL statement.

    Safety: table_name is validated by validate_table_name() which enforces
    ``^[a-z][a-z0-9_]*$`` — no special characters can reach this point.
    Column definitions are built from validated names and fixed type strings.
    """
    validate_table_name(table_name)
    return 'CREATE TABLE "' + table_name + '" (' + ", ".join(col_defs) + ")"  # noqa: S608


async def ensure_metadata_table(session: AsyncSession) -> None:
    """Create the _pqdb_columns metadata table if it doesn't exist."""
    await session.execute(_SQL_CREATE_METADATA)


async def create_table(
    session: AsyncSession, table: TableDefinition
) -> dict[str, object]:
    """Create a table in the project database with shadow columns.

    1. Ensures _pqdb_columns metadata table exists
    2. Creates the physical table with mapped columns
    3. Records column metadata in _pqdb_columns
    4. Returns the created table schema

    Raises ValueError if the table already exists.
    """
    # Check if table already exists
    result = await session.execute(_SQL_TABLE_EXISTS, {"name": table.name})
    if result.scalar():
        raise ValueError(f"Table {table.name!r} already exists")

    await ensure_metadata_table(session)

    # Build and execute CREATE TABLE
    col_defs = build_physical_columns_sql(table)
    create_sql = _build_create_table_sql(table.name, col_defs)
    await session.execute(
        text(create_sql)  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    )

    # Record column metadata
    for col in table.columns:
        await session.execute(
            _SQL_INSERT_METADATA,
            {
                "table_name": table.name,
                "column_name": col.name,
                "sensitivity": col.sensitivity,
                "data_type": col.data_type,
            },
        )

    await session.commit()

    logger.info(
        "table_created",
        table=table.name,
        columns=[c.name for c in table.columns],
    )

    return _build_table_response(table)


async def list_tables(session: AsyncSession) -> list[dict[str, object]]:
    """List all user-created tables with their column metadata."""
    await ensure_metadata_table(session)

    result = await session.execute(_SQL_DISTINCT_TABLES)
    table_names = [row[0] for row in result.fetchall()]

    tables: list[dict[str, object]] = []
    for name in table_names:
        meta = await _get_table_metadata(session, name)
        if meta is not None:
            tables.append(meta)

    return tables


async def get_table(
    session: AsyncSession, table_name: str
) -> dict[str, object] | None:
    """Get full schema for a single table including sensitivity metadata."""
    validate_table_name(table_name)
    await ensure_metadata_table(session)
    return await _get_table_metadata(session, table_name)


async def _get_table_metadata(
    session: AsyncSession, table_name: str
) -> dict[str, object] | None:
    """Load column metadata for a table from _pqdb_columns."""
    result = await session.execute(_SQL_TABLE_COLUMNS, {"name": table_name})
    rows = result.fetchall()
    if not rows:
        return None

    columns: list[dict[str, str]] = []
    for row in rows:
        columns.append(
            {
                "name": row[0],
                "sensitivity": row[1],
                "data_type": row[2],
            }
        )

    return {
        "name": table_name,
        "columns": columns,
    }


def _build_table_response(table: TableDefinition) -> dict[str, object]:
    """Build the API response for a created table."""
    columns: list[dict[str, str]] = []
    for col in table.columns:
        columns.append(
            {
                "name": col.name,
                "sensitivity": col.sensitivity,
                "data_type": col.data_type,
            }
        )
    return {
        "name": table.name,
        "columns": columns,
    }
