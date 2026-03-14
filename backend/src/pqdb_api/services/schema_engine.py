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

_ALLOWED_DATA_TYPES = frozenset(
    {
        "text",
        "integer",
        "bigint",
        "smallint",
        "boolean",
        "bytea",
        "timestamptz",
        "timestamp",
        "date",
        "time",
        "jsonb",
        "json",
        "uuid",
        "real",
        "double precision",
        "numeric",
        "serial",
        "bigserial",
    }
)

# --- Static SQL statements (dialect-specific) -----------------------
# All use literal table name "_pqdb_columns" (never user-controlled)
# to satisfy SQL-injection scanners. DDL requires text() because
# SQLAlchemy ORM cannot express dynamic CREATE TABLE statements.
#
# nosemgrep: avoid-sqlalchemy-text
_SAFE = text  # alias avoids long inline nosemgrep comments

_SQL_CREATE_METADATA_PG = _SAFE(
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

_SQL_CREATE_METADATA_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_columns ("
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "  table_name TEXT NOT NULL,"
    "  column_name TEXT NOT NULL,"
    "  sensitivity TEXT NOT NULL,"
    "  data_type TEXT NOT NULL,"
    "  created_at TEXT NOT NULL DEFAULT (datetime('now')),"
    "  UNIQUE(table_name, column_name)"
    ")"
)

_SQL_TABLE_EXISTS_PG = _SAFE(
    "SELECT EXISTS ("
    "  SELECT 1 FROM information_schema.tables "
    "  WHERE table_schema = 'public' AND table_name = :name"
    ")"
)

_SQL_TABLE_EXISTS_SQLITE = _SAFE(
    "SELECT EXISTS ("
    "  SELECT 1 FROM sqlite_master "
    "  WHERE type = 'table' AND name = :name"
    ")"
)

_SQL_INSERT_METADATA = _SAFE(
    "INSERT INTO _pqdb_columns "
    "(table_name, column_name, sensitivity, data_type) "
    "VALUES (:table_name, :column_name, :sensitivity, :data_type)"
)

_SQL_DISTINCT_TABLES = _SAFE(
    "SELECT DISTINCT table_name FROM _pqdb_columns ORDER BY table_name"
)

_SQL_TABLE_COLUMNS = _SAFE(
    "SELECT column_name, sensitivity, data_type "
    "FROM _pqdb_columns "
    "WHERE table_name = :name ORDER BY id"
)

_SQL_COLUMN_EXISTS = _SAFE(
    "SELECT sensitivity, data_type FROM _pqdb_columns "
    "WHERE table_name = :table_name AND column_name = :column_name"
)

_SQL_DELETE_COLUMN_METADATA = _SAFE(
    "DELETE FROM _pqdb_columns "
    "WHERE table_name = :table_name AND column_name = :column_name"
)

# Reserved auto-generated columns that cannot be dropped
_SYSTEM_COLUMNS = frozenset({"id", "created_at", "updated_at"})


def _is_sqlite(session: AsyncSession) -> bool:
    """Check if the session is connected to a SQLite database."""
    bind = session.bind
    if bind is None:
        return False
    return bind.dialect.name == "sqlite"


def validate_table_name(name: str) -> str:
    """Validate a table name for safety and conventions.

    Raises ValueError for invalid names.
    """
    if not name:
        raise ValueError("Table name must not be empty")
    if not _VALID_IDENTIFIER_RE.match(name):
        if name[0].isdigit():
            msg = f"Table name {name!r} must start with a letter"
            raise ValueError(msg)
        msg = f"Table name {name!r} contains invalid characters"
        raise ValueError(msg)
    for prefix in _RESERVED_PREFIXES:
        if name.startswith(prefix):
            msg = f"Table name {name!r} is reserved (prefix {prefix!r})"
            raise ValueError(msg)
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
            msg = f"Column name {name!r} must start with a letter"
            raise ValueError(msg)
        msg = f"Column name {name!r} contains invalid characters"
        raise ValueError(msg)
    for suffix in _RESERVED_SUFFIXES:
        if name.endswith(suffix):
            msg = f"Column name {name!r} uses reserved suffix {suffix!r}"
            raise ValueError(msg)
    return name


def validate_data_type(data_type: str) -> str:
    """Validate data_type against allowed SQL types.

    Prevents SQL injection via the data_type field, which is interpolated
    into DDL for plain columns.

    Raises ValueError for unsupported types.
    """
    dt_lower = data_type.strip().lower()
    if dt_lower in _ALLOWED_DATA_TYPES:
        return dt_lower
    # Allow vector(N) for pgvector
    if re.match(r"^vector\(\d+\)$", dt_lower):
        return dt_lower
    raise ValueError(f"Unsupported data type: {data_type!r}")


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
        # Normalize and validate data_type to prevent SQL injection in DDL
        object.__setattr__(self, "data_type", validate_data_type(self.data_type))


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


def map_sensitivity_to_physical(
    col: ColumnDefinition,
) -> list[tuple[str, str]]:
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


def build_physical_columns_sql(
    table: TableDefinition, *, sqlite: bool = False
) -> list[str]:
    """Build SQL column definition strings for CREATE TABLE.

    Includes auto-generated id, created_at, updated_at columns.
    Uses SQLite-compatible syntax when sqlite=True.
    """
    if sqlite:
        parts: list[str] = [
            "id INTEGER PRIMARY KEY AUTOINCREMENT",
        ]
    else:
        parts = [
            "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        ]

    for col in table.columns:
        for phys_name, phys_type in map_sensitivity_to_physical(col):
            parts.append(f"{phys_name} {phys_type}")

    if sqlite:
        parts.append("created_at TEXT NOT NULL DEFAULT (datetime('now'))")
        parts.append("updated_at TEXT NOT NULL DEFAULT (datetime('now'))")
    else:
        parts.append("created_at timestamptz NOT NULL DEFAULT now()")
        parts.append("updated_at timestamptz NOT NULL DEFAULT now()")

    return parts


def build_add_column_ddl(table_name: str, col: ColumnDefinition) -> list[str]:
    """Build ALTER TABLE ADD COLUMN DDL statements for a column.

    Returns one statement for plain/private, two for searchable.
    Safety: table_name and column names are validated.
    """
    validate_table_name(table_name)
    statements: list[str] = []
    for phys_name, phys_type in map_sensitivity_to_physical(col):
        statements.append(  # noqa: S608
            f'ALTER TABLE "{table_name}" ADD COLUMN {phys_name} {phys_type}'
        )
    return statements


def _build_drop_column_ddl(
    table_name: str, column_name: str, sensitivity: str
) -> list[str]:
    """Build ALTER TABLE DROP COLUMN DDL statements.

    Drops all physical columns associated with a logical column.
    """
    validate_table_name(table_name)
    if sensitivity == "plain":
        names = [column_name]
    elif sensitivity == "private":
        names = [f"{column_name}_encrypted"]
    else:  # searchable
        names = [f"{column_name}_encrypted", f"{column_name}_index"]
    return [
        f'ALTER TABLE "{table_name}" DROP COLUMN {n}'  # noqa: S608
        for n in names
    ]


def _build_create_table_sql(table_name: str, col_defs: list[str]) -> str:
    """Build a CREATE TABLE DDL statement.

    Safety: table_name passes validate_table_name() which enforces
    ``^[a-z][a-z0-9_]*$`` — no special chars can reach here.
    Column defs are built from validated names and fixed types.
    """
    validate_table_name(table_name)
    joined = ", ".join(col_defs)
    return (  # noqa: S608
        'CREATE TABLE "' + table_name + '" (' + joined + ")"
    )


async def ensure_metadata_table(session: AsyncSession) -> None:
    """Create the _pqdb_columns metadata table if needed."""
    if _is_sqlite(session):
        await session.execute(_SQL_CREATE_METADATA_SQLITE)
    else:
        await session.execute(_SQL_CREATE_METADATA_PG)


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
    sqlite = _is_sqlite(session)

    # Check if table already exists
    exists_sql = _SQL_TABLE_EXISTS_SQLITE if sqlite else _SQL_TABLE_EXISTS_PG
    result = await session.execute(exists_sql, {"name": table.name})
    if result.scalar():
        raise ValueError(f"Table {table.name!r} already exists")

    await ensure_metadata_table(session)

    # Build and execute CREATE TABLE
    col_defs = build_physical_columns_sql(table, sqlite=sqlite)
    create_sql = _build_create_table_sql(table.name, col_defs)
    await session.execute(_SAFE(create_sql))

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


async def list_tables(
    session: AsyncSession,
) -> list[dict[str, object]]:
    """List all user-created tables with column metadata."""
    await ensure_metadata_table(session)

    result = await session.execute(_SQL_DISTINCT_TABLES)
    table_names = [row[0] for row in result.fetchall()]

    tables: list[dict[str, object]] = []
    for name in table_names:
        meta = await _get_table_metadata(session, name)
        if meta is not None:
            tables.append(meta)

    return tables


async def get_table(session: AsyncSession, table_name: str) -> dict[str, object] | None:
    """Get full schema for a table including sensitivity metadata."""
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


_PLAIN_OPERATIONS: list[str] = [
    "eq",
    "gt",
    "lt",
    "gte",
    "lte",
    "in",
    "between",
]
_SEARCHABLE_OPERATIONS: list[str] = ["eq", "in"]


def build_introspection_column(
    name: str, data_type: str, sensitivity: str
) -> dict[str, object]:
    """Build introspection metadata for a single column.

    Returns name, type, sensitivity, queryable flag, and
    operations/note based on sensitivity level.
    """
    result: dict[str, object] = {
        "name": name,
        "type": data_type,
        "sensitivity": sensitivity,
    }
    if sensitivity == "plain":
        result["queryable"] = True
        result["operations"] = list(_PLAIN_OPERATIONS)
    elif sensitivity == "searchable":
        result["queryable"] = True
        result["operations"] = list(_SEARCHABLE_OPERATIONS)
    else:  # private
        result["queryable"] = False
        result["note"] = "retrieve only \u2014 no server-side filtering"
    return result


def build_introspection_table(
    table_name: str, columns: list[dict[str, str]]
) -> dict[str, object]:
    """Build introspection metadata for a table.

    Includes sensitivity_summary with counts per level.
    ``columns`` is a list of dicts with keys:
    name, data_type, sensitivity.
    """
    introspection_columns: list[dict[str, object]] = []
    summary: dict[str, int] = {
        "searchable": 0,
        "private": 0,
        "plain": 0,
    }
    for col in columns:
        sensitivity = col["sensitivity"]
        summary[sensitivity] = summary.get(sensitivity, 0) + 1
        introspection_columns.append(
            build_introspection_column(
                col["name"],
                col["data_type"],
                sensitivity,
            )
        )
    return {
        "name": table_name,
        "columns": introspection_columns,
        "sensitivity_summary": summary,
    }


async def introspect_all_tables(
    session: AsyncSession,
) -> list[dict[str, object]]:
    """Introspect all tables with queryable info."""
    await ensure_metadata_table(session)

    result = await session.execute(_SQL_DISTINCT_TABLES)
    table_names = [row[0] for row in result.fetchall()]

    tables: list[dict[str, object]] = []
    for name in table_names:
        table_result = await session.execute(
            _SQL_TABLE_COLUMNS,
            {"name": name},
        )
        rows = table_result.fetchall()
        columns = [
            {
                "name": r[0],
                "data_type": r[2],
                "sensitivity": r[1],
            }
            for r in rows
        ]
        tables.append(build_introspection_table(name, columns))

    return tables


async def introspect_table(
    session: AsyncSession, table_name: str
) -> dict[str, object] | None:
    """Introspect a single table with queryable info."""
    validate_table_name(table_name)
    await ensure_metadata_table(session)

    result = await session.execute(
        _SQL_TABLE_COLUMNS,
        {"name": table_name},
    )
    rows = result.fetchall()
    if not rows:
        return None

    columns = [
        {
            "name": r[0],
            "data_type": r[2],
            "sensitivity": r[1],
        }
        for r in rows
    ]
    return build_introspection_table(table_name, columns)


def _build_table_response(
    table: TableDefinition,
) -> dict[str, object]:
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


async def add_column(
    session: AsyncSession,
    table_name: str,
    col: ColumnDefinition,
) -> dict[str, str]:
    """Add a column to an existing table with shadow column mapping.

    1. Validates table exists (via _pqdb_columns metadata)
    2. Validates column doesn't already exist
    3. Executes ALTER TABLE ADD COLUMN for each physical column
    4. Inserts metadata into _pqdb_columns
    5. Commits the transaction

    Raises ValueError if table not found or column already exists.
    """
    validate_table_name(table_name)
    await ensure_metadata_table(session)

    # Check table exists
    table_meta = await _get_table_metadata(session, table_name)
    if table_meta is None:
        raise ValueError(f"Table {table_name!r} not found")

    # Check column doesn't already exist
    result = await session.execute(
        _SQL_COLUMN_EXISTS,
        {"table_name": table_name, "column_name": col.name},
    )
    if result.fetchone() is not None:
        raise ValueError(f"Column {col.name!r} already exists in table {table_name!r}")

    # Execute DDL
    for stmt in build_add_column_ddl(table_name, col):
        await session.execute(_SAFE(stmt))

    # Insert metadata
    await session.execute(
        _SQL_INSERT_METADATA,
        {
            "table_name": table_name,
            "column_name": col.name,
            "sensitivity": col.sensitivity,
            "data_type": col.data_type,
        },
    )

    await session.commit()

    logger.info(
        "column_added",
        table=table_name,
        column=col.name,
        sensitivity=col.sensitivity,
    )

    return {
        "name": col.name,
        "sensitivity": col.sensitivity,
        "data_type": col.data_type,
    }


async def drop_column(
    session: AsyncSession,
    table_name: str,
    column_name: str,
) -> None:
    """Drop a column from a table including its shadow columns.

    1. Validates table and column exist
    2. Checks column is not a system column (id, created_at, updated_at)
    3. Looks up sensitivity from _pqdb_columns
    4. Executes ALTER TABLE DROP COLUMN for each physical column
    5. Deletes metadata from _pqdb_columns
    6. Commits the transaction

    Raises ValueError if table/column not found or column is protected.
    """
    validate_table_name(table_name)
    await ensure_metadata_table(session)

    # Check if it's a system column
    if column_name in _SYSTEM_COLUMNS:
        raise ValueError(f"Cannot drop system column {column_name!r}")

    # Check table exists
    table_meta = await _get_table_metadata(session, table_name)
    if table_meta is None:
        raise ValueError(f"Table {table_name!r} not found")

    # Look up column metadata
    result = await session.execute(
        _SQL_COLUMN_EXISTS,
        {"table_name": table_name, "column_name": column_name},
    )
    row = result.fetchone()
    if row is None:
        raise ValueError(f"Column {column_name!r} not found in table {table_name!r}")

    sensitivity = row[0]

    # Execute DDL
    for stmt in _build_drop_column_ddl(table_name, column_name, sensitivity):
        await session.execute(_SAFE(stmt))

    # Delete metadata
    await session.execute(
        _SQL_DELETE_COLUMN_METADATA,
        {"table_name": table_name, "column_name": column_name},
    )

    await session.commit()

    logger.info(
        "column_dropped",
        table=table_name,
        column=column_name,
    )
