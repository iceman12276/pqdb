"""Project-scoped database endpoints.

All routes under ``/v1/db`` require a valid ``apikey`` header.
The API key middleware resolves the project and injects a project-scoped
database session.
"""

from __future__ import annotations

from typing import Any, cast

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.crud import (
    CrudError,
    FilterOp,
    build_delete_sql,
    build_insert_sql,
    build_select_sql,
    build_update_sql,
    resolve_physical_column,
    validate_columns_for_insert,
    validate_filter_column,
)
from pqdb_api.services.schema_engine import (
    ColumnDefinition,
    Sensitivity,
    TableDefinition,
    create_table,
    ensure_metadata_table,
    get_table,
    list_tables,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/db", tags=["db"])


# --- Request / Response models ---


class ColumnSchema(BaseModel):
    """Column definition in a table creation request."""

    name: str
    data_type: str
    sensitivity: str = "plain"

    @field_validator("sensitivity")
    @classmethod
    def validate_sensitivity(cls, v: str) -> str:
        if v not in ("plain", "private", "searchable"):
            raise ValueError("sensitivity must be 'plain', 'private', or 'searchable'")
        return v


class CreateTableRequest(BaseModel):
    """Request body for POST /v1/db/tables."""

    name: str
    columns: list[ColumnSchema]


class FilterSchema(BaseModel):
    """A single filter in a query."""

    column: str
    op: str
    value: Any

    @field_validator("op")
    @classmethod
    def validate_op(cls, v: str) -> str:
        valid = {"eq", "gt", "lt", "gte", "lte", "in"}
        if v not in valid:
            raise ValueError(f"op must be one of {sorted(valid)}")
        return v


class ModifiersSchema(BaseModel):
    """Query modifiers for select."""

    limit: int | None = None
    offset: int | None = None
    order_by: str | None = None
    order_dir: str | None = None


class InsertRequest(BaseModel):
    """Request body for POST /v1/db/{table}/insert."""

    rows: list[dict[str, Any]]


class SelectRequest(BaseModel):
    """Request body for POST /v1/db/{table}/select."""

    columns: list[str] = ["*"]
    filters: list[FilterSchema] = []
    modifiers: ModifiersSchema = ModifiersSchema()


class UpdateRequest(BaseModel):
    """Request body for POST /v1/db/{table}/update."""

    values: dict[str, Any]
    filters: list[FilterSchema] = []


class DeleteRequest(BaseModel):
    """Request body for POST /v1/db/{table}/delete."""

    filters: list[FilterSchema] = []


# --- Helpers ---


async def _get_column_meta(
    session: AsyncSession, table_name: str
) -> list[dict[str, str]]:
    """Load column metadata for a table from _pqdb_columns.

    Raises HTTPException 404 if the table does not exist.
    Returns list of dicts with keys: name, sensitivity, data_type.
    """
    await ensure_metadata_table(session)
    result = await session.execute(
        text(
            "SELECT column_name, sensitivity, data_type "
            "FROM _pqdb_columns WHERE table_name = :name ORDER BY id"
        ),
        {"name": table_name},
    )
    rows = result.fetchall()
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"Table {table_name!r} not found",
        )
    return [
        {
            "name": r[0],
            "sensitivity": r[1],
            "data_type": r[2],
        }
        for r in rows
    ]


def _rows_to_dicts(result: Any) -> list[dict[str, Any]]:
    """Convert SQLAlchemy row results to list of dicts."""
    if result.returns_rows:
        keys = list(result.keys())
        return [dict(zip(keys, row)) for row in result.fetchall()]
    return []


def _parse_filter_op(op_str: str) -> FilterOp:
    """Convert string filter op to FilterOp enum."""
    return FilterOp(op_str)


def _parse_filters(
    filter_schemas: list[FilterSchema],
    columns_meta: list[dict[str, str]],
) -> list[tuple[str, FilterOp, Any]]:
    """Parse and validate filters, resolving physical column names."""
    parsed: list[tuple[str, FilterOp, Any]] = []
    for f in filter_schemas:
        op = _parse_filter_op(f.op)
        try:
            validate_filter_column(f.column, columns_meta, op=op)
            physical_col = resolve_physical_column(
                f.column, columns_meta, for_filter=True
            )
        except CrudError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        parsed.append((physical_col, op, f.value))
    return parsed


# --- Endpoints ---


@router.get("/health")
async def db_health(
    context: ProjectContext = Depends(get_project_context),
) -> dict[str, object]:
    """Project database health — confirms API key resolves to a valid project."""
    return {
        "status": "ok",
        "project_id": str(context.project_id),
        "role": context.key_role,
    }


@router.post("/tables", status_code=201)
async def create_table_endpoint(
    body: CreateTableRequest,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Create a table with column sensitivity metadata.

    Creates physical shadow columns based on sensitivity levels:
    - plain: column as-is with declared SQL type
    - private: {col}_encrypted (bytea)
    - searchable: {col}_encrypted (bytea) + {col}_index (text)
    """
    try:
        table_def = TableDefinition(
            name=body.name,
            columns=[
                ColumnDefinition(
                    name=c.name,
                    data_type=c.data_type,
                    sensitivity=cast(Sensitivity, c.sensitivity),
                )
                for c in body.columns
            ],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        result = await create_table(session, table_def)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return result


@router.get("/tables")
async def list_tables_endpoint(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List all tables in the project database with column metadata."""
    tables = await list_tables(session)
    return tables


@router.get("/tables/{table_name}")
async def get_table_endpoint(
    table_name: str,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Get full schema for a table including sensitivity levels."""
    try:
        result = await get_table(session, table_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Table {table_name!r} not found",
        )

    return result


# --- CRUD endpoints ---


@router.post("/{table_name}/insert", status_code=201)
async def insert_rows(
    table_name: str,
    body: InsertRequest,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Insert rows into a project table.

    The SDK sends data with shadow column names already applied
    (_encrypted, _index suffixes). The server validates and stores as-is.
    """
    columns_meta = await _get_column_meta(session, table_name)

    if not body.rows:
        raise HTTPException(status_code=400, detail="Must provide at least one row")

    try:
        inserted: list[dict[str, Any]] = []
        for row in body.rows:
            physical_row = validate_columns_for_insert(row, columns_meta)
            sql, params = build_insert_sql(table_name, physical_row)
            result = await session.execute(text(sql), params)
            inserted.extend(_rows_to_dicts(result))
        await session.commit()
    except CrudError as exc:
        await session.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        await session.rollback()
        exc_str = str(exc).lower()
        if "unique" in exc_str or "duplicate" in exc_str:
            raise HTTPException(
                status_code=409, detail="Unique constraint violation"
            ) from exc
        logger.error("insert_failed", table=table_name, error=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"data": inserted}


@router.post("/{table_name}/select")
async def select_rows(
    table_name: str,
    body: SelectRequest,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Select rows from a project table.

    Supports filtering by blind index (eq, in) and plain columns
    (eq, gt, lt, gte, lte, in). Private columns are not filterable.
    """
    columns_meta = await _get_column_meta(session, table_name)

    # Parse and validate filters
    try:
        filters = _parse_filters(body.filters, columns_meta)
    except HTTPException:
        raise

    # Build order_by as list of tuples
    order_by: list[tuple[str, str]] | None = None
    if body.modifiers.order_by:
        direction = body.modifiers.order_dir or "asc"
        order_by = [(body.modifiers.order_by, direction)]

    try:
        sql, params = build_select_sql(
            table_name,
            columns=body.columns if body.columns != ["*"] else None,
            filters=filters if filters else None,
            limit=body.modifiers.limit,
            offset=body.modifiers.offset,
            order_by=order_by,
        )
    except CrudError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result = await session.execute(text(sql), params)
    rows = _rows_to_dicts(result)

    return {"data": rows}


@router.post("/{table_name}/update")
async def update_rows(
    table_name: str,
    body: UpdateRequest,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Update rows in a project table.

    Matches rows via filters (typically blind index), updates the
    specified columns. Returns updated rows.
    """
    columns_meta = await _get_column_meta(session, table_name)

    if not body.values:
        raise HTTPException(status_code=400, detail="Must provide values to update")

    # Map update values to physical columns
    try:
        physical_updates: dict[str, Any] = {}
        for col, val in body.values.items():
            physical_col = resolve_physical_column(
                col, columns_meta, for_insert=True
            )
            physical_updates[physical_col] = val
            # Also include index if searchable and _index is provided
    except CrudError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Parse filters
    try:
        filters = _parse_filters(body.filters, columns_meta)
    except HTTPException:
        raise

    try:
        sql, params = build_update_sql(
            table_name,
            updates=physical_updates,
            filters=filters,
        )
    except CrudError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        result = await session.execute(text(sql), params)
        updated = _rows_to_dicts(result)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        exc_str = str(exc).lower()
        if "unique" in exc_str or "duplicate" in exc_str:
            raise HTTPException(
                status_code=409, detail="Unique constraint violation"
            ) from exc
        logger.error("update_failed", table=table_name, error=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"data": updated}


@router.post("/{table_name}/delete")
async def delete_rows(
    table_name: str,
    body: DeleteRequest,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Delete rows from a project table.

    Requires at least one filter to prevent accidental full-table deletion.
    Returns deleted rows.
    """
    columns_meta = await _get_column_meta(session, table_name)

    # Parse filters
    try:
        filters = _parse_filters(body.filters, columns_meta)
    except HTTPException:
        raise

    try:
        sql, params = build_delete_sql(
            table_name,
            filters=filters,
        )
    except CrudError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        result = await session.execute(text(sql), params)
        deleted = _rows_to_dicts(result)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        logger.error("delete_failed", table=table_name, error=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"data": deleted}
