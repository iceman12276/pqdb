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
            raise ValueError("sensitivity must be 'plain', 'private', or 'searchable'")
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


@router.post("/tables/{table_name}/columns", status_code=201)
async def add_column_endpoint(
    table_name: str,
    body: ColumnSchema,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Add a column to an existing table with sensitivity declaration.

    Creates physical shadow columns based on sensitivity level:
    - plain: column as-is with declared SQL type
    - private: {col}_encrypted (bytea)
    - searchable: {col}_encrypted (bytea) + {col}_index (text)
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
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return result


@router.delete("/tables/{table_name}/columns/{column_name}")
async def drop_column_endpoint(
    table_name: str,
    column_name: str,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Drop a column from a table, including shadow columns.

    Removes the physical column(s) and metadata atomically.
    Cannot drop primary key (id) or reserved columns.
    """
    try:
        result = await drop_column(session, table_name, column_name)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result
