"""CRUD service — query building with blind-index-aware column routing.

Builds parameterized SQL for insert, select, update, and delete operations.
Sensitive columns are routed to their physical shadow columns:
- searchable: filters use {col}_index, inserts use {col}_encrypted + {col}_index
- private: inserts use {col}_encrypted, filtering is forbidden
- plain: passthrough
"""

from __future__ import annotations

import enum
import uuid
from typing import Any

from pqdb_api.services.schema_engine import validate_table_name


class CrudError(Exception):
    """Error raised for invalid CRUD operations."""


class FilterOp(enum.Enum):
    """Supported filter operations."""

    EQ = "eq"
    GT = "gt"
    LT = "lt"
    GTE = "gte"
    LTE = "lte"
    IN = "in"


_OP_SQL = {
    FilterOp.EQ: "=",
    FilterOp.GT: ">",
    FilterOp.LT: "<",
    FilterOp.GTE: ">=",
    FilterOp.LTE: "<=",
}

# Searchable columns only support equality-based filtering via blind index
_SEARCHABLE_ALLOWED_OPS = frozenset({FilterOp.EQ, FilterOp.IN})


def _find_column_meta(
    col_name: str, columns_meta: list[dict[str, str]]
) -> dict[str, str] | None:
    """Find column metadata by logical name."""
    for col in columns_meta:
        if col["name"] == col_name:
            return col
    return None


def resolve_physical_column(
    col_name: str,
    columns_meta: list[dict[str, str]],
    *,
    for_insert: bool = False,
    for_filter: bool = False,
) -> str:
    """Resolve a logical column name to its physical column name.

    For insert: searchable/private → {col}_encrypted
    For filter: searchable → {col}_index, private → error
    Default: plain passthrough, sensitive → encrypted
    """
    meta = _find_column_meta(col_name, columns_meta)
    if meta is None:
        raise CrudError(f"Unknown column: {col_name!r}")

    sensitivity = meta["sensitivity"]

    if sensitivity == "plain":
        return col_name
    elif sensitivity == "searchable":
        if for_filter:
            return f"{col_name}_index"
        return f"{col_name}_encrypted"
    else:  # private
        if for_filter:
            raise CrudError(f"Cannot filter on private column {col_name!r}")
        return f"{col_name}_encrypted"


def validate_filter_column(
    col_name: str,
    columns_meta: list[dict[str, str]],
    *,
    op: FilterOp = FilterOp.EQ,
) -> None:
    """Validate that a column can be used in a filter with the given op.

    Raises CrudError if:
    - Column is unknown
    - Column is private (cannot filter on encrypted-only columns)
    - Column is searchable but op is not eq/in
    """
    meta = _find_column_meta(col_name, columns_meta)
    if meta is None:
        raise CrudError(f"Unknown column: {col_name!r}")

    sensitivity = meta["sensitivity"]

    if sensitivity == "private":
        raise CrudError(f"Cannot filter on private column {col_name!r}")

    if sensitivity == "searchable" and op not in _SEARCHABLE_ALLOWED_OPS:
        raise CrudError(f"Searchable column {col_name!r} only supports eq/in filters")


def validate_columns_for_insert(
    row: dict[str, Any],
    columns_meta: list[dict[str, str]],
) -> dict[str, Any]:
    """Validate and map insert payload columns to physical names.

    For searchable columns, the client sends:
    - {col}: the encrypted value → mapped to {col}_encrypted
    - {col}_index: the blind index → kept as {col}_index

    For private columns, the client sends:
    - {col}: the encrypted value → mapped to {col}_encrypted

    For plain columns:
    - {col}: the value → kept as-is
    """
    physical: dict[str, Any] = {}
    seen_logical: set[str] = set()

    for key, value in row.items():
        # Check if this is an _index suffix for a searchable column
        if key.endswith("_index"):
            base_name = key[: -len("_index")]
            meta = _find_column_meta(base_name, columns_meta)
            if meta is not None and meta["sensitivity"] == "searchable":
                physical[key] = value
                seen_logical.add(key)
                continue

        # Normal column lookup
        meta = _find_column_meta(key, columns_meta)
        if meta is None:
            raise CrudError(f"Unknown column: {key!r}")

        sensitivity = meta["sensitivity"]
        if sensitivity == "plain":
            physical[key] = value
        elif sensitivity == "searchable":
            # Encrypted columns are bytea in Postgres — convert str to bytes
            physical[f"{key}_encrypted"] = (
                value.encode("utf-8") if isinstance(value, str) else value
            )
        else:  # private
            physical[f"{key}_encrypted"] = (
                value.encode("utf-8") if isinstance(value, str) else value
            )

        seen_logical.add(key)

    return physical


def build_insert_sql(
    table_name: str,
    physical_row: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    """Build a parameterized INSERT statement.

    Returns (sql, params) tuple. Table name is validated for safety.
    """
    validate_table_name(table_name)

    columns = list(physical_row.keys())
    placeholders = [f":{col}" for col in columns]
    col_str = ", ".join(columns)
    val_str = ", ".join(placeholders)

    sql = f'INSERT INTO "{table_name}" ({col_str}) VALUES ({val_str}) RETURNING *'
    return sql, dict(physical_row)


def _build_where_clause(
    filters: list[tuple[str, FilterOp, Any]],
) -> tuple[str, dict[str, Any]]:
    """Build WHERE clause from filters.

    Returns (where_sql, params). The where_sql includes the WHERE keyword.
    """
    if not filters:
        return "", {}

    conditions: list[str] = []
    params: dict[str, Any] = {}

    for i, (col, op, value) in enumerate(filters):
        param_name = f"f_{i}"

        if op == FilterOp.IN:
            if not isinstance(value, (list, tuple)):
                raise CrudError(f"IN filter for {col!r} requires a list")
            in_params = []
            for j, v in enumerate(value):
                p_name = f"f_{i}_{j}"
                params[p_name] = v
                in_params.append(f":{p_name}")
            in_str = ", ".join(in_params)
            conditions.append(f"{col} IN ({in_str})")
        else:
            sql_op = _OP_SQL[op]
            conditions.append(f"{col} {sql_op} :{param_name}")
            params[param_name] = value

    where_sql = " WHERE " + " AND ".join(conditions)
    return where_sql, params


def build_select_sql(
    table_name: str,
    *,
    columns: list[str] | None = None,
    filters: list[tuple[str, FilterOp, Any]] | None = None,
    limit: int | None = None,
    offset: int | None = None,
    order_by: list[tuple[str, str]] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Build a parameterized SELECT statement.

    Returns (sql, params) tuple.
    """
    validate_table_name(table_name)

    col_str = "*" if not columns else ", ".join(columns)
    sql = f'SELECT {col_str} FROM "{table_name}"'

    params: dict[str, Any] = {}

    if filters:
        where_sql, where_params = _build_where_clause(filters)
        sql += where_sql
        params.update(where_params)

    if order_by:
        order_parts = []
        for col, direction in order_by:
            d = "ASC" if direction.lower() == "asc" else "DESC"
            order_parts.append(f"{col} {d}")
        sql += " ORDER BY " + ", ".join(order_parts)

    if limit is not None:
        sql += " LIMIT :limit"
        params["limit"] = limit

    if offset is not None:
        sql += " OFFSET :offset"
        params["offset"] = offset

    return sql, params


def build_update_sql(
    table_name: str,
    *,
    updates: dict[str, Any],
    filters: list[tuple[str, FilterOp, Any]],
) -> tuple[str, dict[str, Any]]:
    """Build a parameterized UPDATE statement.

    Returns (sql, params) tuple. Requires at least one filter.
    """
    validate_table_name(table_name)

    if not filters:
        raise CrudError("UPDATE requires at least one filter")

    set_parts: list[str] = []
    params: dict[str, Any] = {}

    for col, value in updates.items():
        param_name = f"u_{col}"
        set_parts.append(f"{col} = :{param_name}")
        params[param_name] = value

    set_str = ", ".join(set_parts)
    sql = f'UPDATE "{table_name}" SET {set_str}'

    where_sql, where_params = _build_where_clause(filters)
    sql += where_sql
    params.update(where_params)

    sql += " RETURNING *"
    return sql, params


def build_delete_sql(
    table_name: str,
    *,
    filters: list[tuple[str, FilterOp, Any]],
) -> tuple[str, dict[str, Any]]:
    """Build a parameterized DELETE statement.

    Returns (sql, params) tuple. Requires at least one filter.
    """
    validate_table_name(table_name)

    if not filters:
        raise CrudError("DELETE requires at least one filter")

    sql = f'DELETE FROM "{table_name}"'

    where_sql, where_params = _build_where_clause(filters)
    sql += where_sql

    sql += " RETURNING *"
    return sql, where_params


# --- RLS enforcement helpers ---


def _find_owner_column(
    columns_meta: list[dict[str, Any]],
) -> str | None:
    """Find the owner column name from column metadata, if any."""
    for col in columns_meta:
        if col.get("is_owner"):
            return str(col["name"])
    return None


def inject_rls_filters(
    *,
    filters: list[tuple[str, FilterOp, Any]],
    columns_meta: list[dict[str, Any]],
    key_role: str,
    user_id: uuid.UUID | None,
) -> list[tuple[str, FilterOp, Any]]:
    """Inject RLS WHERE filters based on owner column and user context.

    - service role: no RLS filtering (admin access)
    - anon role + table has owner column + user context present:
      appends WHERE {owner_col} = user_id
    - anon role + table has owner column + NO user context:
      raises CrudError (403)
    - table has no owner column: no RLS applied
    """
    owner_col = _find_owner_column(columns_meta)
    if owner_col is None:
        return list(filters)

    if key_role == "service":
        return list(filters)

    # anon role with owner column
    if user_id is None:
        raise CrudError("User context required for tables with owner column")

    result = list(filters)
    result.append((owner_col, FilterOp.EQ, str(user_id)))
    return result


def validate_owner_for_insert(
    *,
    row: dict[str, Any],
    columns_meta: list[dict[str, Any]],
    key_role: str,
    user_id: uuid.UUID | None,
) -> None:
    """Validate that insert rows respect owner column constraints.

    - service role: no validation
    - anon role + owner column: row must include owner column matching user_id
    - no owner column: no validation
    """
    owner_col = _find_owner_column(columns_meta)
    if owner_col is None:
        return

    if key_role == "service":
        return

    # anon role with owner column
    if user_id is None:
        raise CrudError("User context required for tables with owner column")

    if owner_col not in row:
        raise CrudError(f"Owner column {owner_col!r} required in insert data")

    if str(row[owner_col]) != str(user_id):
        raise CrudError(f"Owner column {owner_col!r} must match authenticated user")
