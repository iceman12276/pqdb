"""Project-scoped database endpoints.

All routes under ``/v1/db`` require a valid ``apikey`` header.
The API key middleware resolves the project and injects a project-scoped
database session.
"""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.schema_engine import (
    ColumnDefinition,
    Sensitivity,
    TableDefinition,
    add_column,
    create_table,
    drop_column,
    get_table,
    introspect_all_tables,
    introspect_table,
    list_tables,
)

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
            msg = "sensitivity must be 'plain', 'private', or 'searchable'"
            raise ValueError(msg)
        return v


class CreateTableRequest(BaseModel):
    """Request body for POST /v1/db/tables."""

    name: str
    columns: list[ColumnSchema]


# --- Endpoints ---


@router.get("/health")
async def db_health(
    context: ProjectContext = Depends(get_project_context),
) -> dict[str, object]:
    """Project database health check."""
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
    """Create a table with column sensitivity metadata."""
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
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    try:
        result = await create_table(session, table_def)
    except ValueError as exc:
        raise HTTPException(
            status_code=409,
            detail=str(exc),
        ) from exc

    return result


@router.get("/tables")
async def list_tables_endpoint(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List all tables with column metadata."""
    tables = await list_tables(session)
    return tables


@router.get("/tables/{table_name}")
async def get_table_endpoint(
    table_name: str,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Get full schema for a table."""
    try:
        result = await get_table(session, table_name)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Table {table_name!r} not found",
        )

    return result


@router.get("/introspect")
async def introspect_all_endpoint(
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Introspect all tables with queryable info."""
    tables = await introspect_all_tables(session)
    return {"tables": tables}


@router.get("/introspect/{table_name}")
async def introspect_table_endpoint(
    table_name: str,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Introspect a single table with queryable info."""
    try:
        result = await introspect_table(
            session,
            table_name,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Table {table_name!r} not found",
        )

    return result


@router.post("/tables/{table_name}/columns", status_code=201)
async def add_column_endpoint(
    table_name: str,
    body: ColumnSchema,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Add a column to an existing table.

    Creates physical shadow columns based on sensitivity level.
    Updates _pqdb_columns metadata atomically with DDL.
    """
    try:
        col_def = ColumnDefinition(
            name=body.name,
            data_type=body.data_type,
            sensitivity=cast(Sensitivity, body.sensitivity),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        result = await add_column(session, table_name, col_def)
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        if "already exists" in msg:
            raise HTTPException(status_code=409, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc

    return result


@router.delete("/tables/{table_name}/columns/{column_name}", status_code=204)
async def drop_column_endpoint(
    table_name: str,
    column_name: str,
    session: AsyncSession = Depends(get_project_session),
) -> None:
    """Drop a column from a table.

    Removes all physical shadow columns and _pqdb_columns metadata.
    Cannot drop system columns (id, created_at, updated_at).
    """
    try:
        await drop_column(session, table_name, column_name)
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        if "Cannot drop system column" in msg:
            raise HTTPException(status_code=400, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
