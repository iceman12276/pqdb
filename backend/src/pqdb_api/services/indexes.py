"""Vector index management service (US-061).

Builds SQL for creating and dropping pgvector indexes (HNSW, IVFFlat).
Validates that the target column is a plain vector(N) column before
allowing index creation.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.services.schema_engine import validate_table_name

logger = structlog.get_logger()

_VECTOR_RE = re.compile(r"^vector\(\d+\)$")
_SAFE_INDEX_NAME_RE = re.compile(r"^idx_[a-z][a-z0-9_]*$")


class IndexType(str, Enum):
    HNSW = "hnsw"
    IVFFLAT = "ivfflat"


class DistanceMetric(str, Enum):
    COSINE = "cosine"
    L2 = "l2"
    INNER_PRODUCT = "inner_product"


class IndexError(Exception):
    """Raised for index validation or creation errors."""


# pgvector operator class mapping
_OPS_CLASS: dict[DistanceMetric, str] = {
    DistanceMetric.COSINE: "vector_cosine_ops",
    DistanceMetric.L2: "vector_l2_ops",
    DistanceMetric.INNER_PRODUCT: "vector_ip_ops",
}


def generate_index_name(table_name: str, column_name: str, index_type: str) -> str:
    """Generate a deterministic index name: idx_{table}_{column}_{type}."""
    return f"idx_{table_name}_{column_name}_{index_type}"


def validate_index_request(
    column: str,
    index_type: IndexType,
    distance: DistanceMetric,
    columns_meta: list[dict[str, Any]],
) -> None:
    """Validate that the column exists and is a plain vector column.

    Raises IndexError if validation fails.
    """
    meta = None
    for col in columns_meta:
        if col["name"] == column:
            meta = col
            break

    if meta is None:
        raise IndexError(f"Column {column!r} not found")

    if meta["sensitivity"] != "plain":
        raise IndexError(
            f"Column {column!r} must be plain sensitivity for indexing"
        )

    if not _VECTOR_RE.match(meta["data_type"]):
        raise IndexError(
            f"Column {column!r} is not a vector column (type: {meta['data_type']})"
        )


def build_create_index_sql(
    table_name: str,
    column_name: str,
    index_type: IndexType,
    distance: DistanceMetric,
) -> str:
    """Build CREATE INDEX SQL for a pgvector index.

    Safety: table_name passes validate_table_name() which enforces
    ``^[a-z][a-z0-9_]*$`` — no special chars can reach here.
    Column names are validated the same way via schema_engine.
    """
    validate_table_name(table_name)
    index_name = generate_index_name(table_name, column_name, index_type.value)
    ops_class = _OPS_CLASS[distance]

    using = index_type.value.upper()

    if index_type == IndexType.IVFFLAT:
        return (  # noqa: S608
            f'CREATE INDEX {index_name} ON "{table_name}" '
            f"USING {using} ({column_name} {ops_class}) "
            f"WITH (lists = 100)"
        )

    return (  # noqa: S608
        f'CREATE INDEX {index_name} ON "{table_name}" '
        f"USING {using} ({column_name} {ops_class})"
    )


def build_drop_index_sql(index_name: str) -> str:
    """Build DROP INDEX SQL.

    Safety: index_name is validated against a strict allowlist.
    """
    if not _SAFE_INDEX_NAME_RE.match(index_name):
        raise IndexError(f"Invalid index name: {index_name!r}")
    return f"DROP INDEX IF EXISTS {index_name}"  # noqa: S608


async def create_index(
    session: AsyncSession,
    table_name: str,
    column: str,
    index_type: IndexType,
    distance: DistanceMetric,
    columns_meta: list[dict[str, Any]],
) -> dict[str, str]:
    """Create a vector index on a table column.

    1. Validates the column is a plain vector type
    2. Checks if index already exists (409)
    3. Executes CREATE INDEX
    4. Returns index metadata

    Raises IndexError for validation failures.
    Raises ValueError with '409' marker for duplicate indexes.
    """
    validate_index_request(column, index_type, distance, columns_meta)

    index_name = generate_index_name(table_name, column, index_type.value)

    # Check if index already exists
    result = await session.execute(
        text(
            "SELECT 1 FROM pg_indexes "
            "WHERE schemaname = 'public' AND indexname = :name"
        ),
        {"name": index_name},
    )
    if result.fetchone() is not None:
        raise ValueError(f"Index {index_name!r} already exists")

    sql = build_create_index_sql(table_name, column, index_type, distance)
    await session.execute(text(sql))
    await session.commit()

    logger.info(
        "index_created",
        table=table_name,
        column=column,
        index_name=index_name,
        index_type=index_type.value,
        distance=distance.value,
    )

    return {
        "index_name": index_name,
        "table": table_name,
        "column": column,
        "type": index_type.value,
        "distance": distance.value,
    }


async def list_indexes(
    session: AsyncSession,
    table_name: str,
) -> list[dict[str, str]]:
    """List all vector indexes on a table.

    Queries pg_indexes for indexes matching the idx_{table}_* pattern.
    Returns list of dicts with index_name, column, type, distance.
    """
    validate_table_name(table_name)
    prefix = f"idx_{table_name}_%"

    result = await session.execute(
        text(
            "SELECT indexname, indexdef FROM pg_indexes "
            "WHERE schemaname = 'public' AND indexname LIKE :prefix"
        ),
        {"prefix": prefix},
    )

    indexes: list[dict[str, str]] = []
    for row in result.fetchall():
        index_name = row[0]
        indexdef = row[1]
        parsed = _parse_index_def(index_name, indexdef)
        if parsed is not None:
            indexes.append(parsed)

    return indexes


def _parse_index_def(index_name: str, indexdef: str) -> dict[str, str] | None:
    """Parse a pg_indexes indexdef to extract column, type, and distance.

    Example indexdef:
      CREATE INDEX idx_docs_emb_hnsw ON public.docs USING hnsw (emb vector_cosine_ops)
    """
    # Extract index type from name suffix
    parts = index_name.rsplit("_", 1)
    if len(parts) != 2:
        return None
    index_type = parts[1]
    if index_type not in ("hnsw", "ivfflat"):
        return None

    # Extract column from between parentheses
    match = re.search(r"\((\w+)\s+", indexdef)
    if not match:
        return None
    column = match.group(1)

    # Extract ops class to determine distance
    distance = "cosine"  # default
    if "vector_l2_ops" in indexdef:
        distance = "l2"
    elif "vector_ip_ops" in indexdef:
        distance = "inner_product"
    elif "vector_cosine_ops" in indexdef:
        distance = "cosine"

    return {
        "index_name": index_name,
        "column": column,
        "type": index_type,
        "distance": distance,
    }


async def drop_index(
    session: AsyncSession,
    table_name: str,
    index_name: str,
) -> None:
    """Drop a vector index.

    Validates the index exists and belongs to the given table.
    Raises IndexError if index doesn't exist or name is invalid.
    """
    validate_table_name(table_name)

    # Verify the index exists and belongs to this table
    expected_prefix = f"idx_{table_name}_"
    if not index_name.startswith(expected_prefix):
        raise IndexError(
            f"Index {index_name!r} does not belong to table {table_name!r}"
        )

    result = await session.execute(
        text(
            "SELECT 1 FROM pg_indexes "
            "WHERE schemaname = 'public' AND indexname = :name"
        ),
        {"name": index_name},
    )
    if result.fetchone() is None:
        raise IndexError(f"Index {index_name!r} not found")

    sql = build_drop_index_sql(index_name)
    await session.execute(text(sql))
    await session.commit()

    logger.info(
        "index_dropped",
        table=table_name,
        index_name=index_name,
    )
