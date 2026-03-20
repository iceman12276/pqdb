"""Vector index management endpoints (US-061).

Provides CRUD for pgvector indexes on project tables.
Routes are nested under ``/v1/db/tables/{name}/indexes``.
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import get_project_session
from pqdb_api.services.indexes import (
    DistanceMetric,
    IndexType,
    create_index,
    drop_index,
    list_indexes,
)
from pqdb_api.services.indexes import (
    IndexError as IdxError,
)
from pqdb_api.services.schema_engine import ensure_metadata_table

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/db/tables", tags=["indexes"])


class CreateIndexRequest(BaseModel):
    """Request body for POST /v1/db/tables/{name}/indexes."""

    column: str
    type: str
    distance: str = "cosine"

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        valid = {"hnsw", "ivfflat"}
        if v not in valid:
            raise ValueError(f"type must be one of {sorted(valid)}")
        return v

    @field_validator("distance")
    @classmethod
    def validate_distance(cls, v: str) -> str:
        valid = {"cosine", "l2", "inner_product"}
        if v not in valid:
            raise ValueError(f"distance must be one of {sorted(valid)}")
        return v


async def _get_column_meta(
    session: AsyncSession, table_name: str
) -> list[dict[str, Any]]:
    """Load column metadata for a table from _pqdb_columns."""
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


@router.post("/{table_name}/indexes", status_code=201)
async def create_index_endpoint(
    table_name: str,
    body: CreateIndexRequest,
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Create a vector index on a table column.

    Accepts { column, type, distance } where type is 'hnsw' or 'ivfflat'
    and distance is 'cosine', 'l2', or 'inner_product'.
    Index name is auto-generated as idx_{table}_{column}_{type}.
    Returns 409 if index already exists.
    """
    columns_meta = await _get_column_meta(session, table_name)

    try:
        result = await create_index(
            session,
            table_name,
            body.column,
            IndexType(body.type),
            DistanceMetric(body.distance),
            columns_meta,
        )
    except IdxError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        if "already exists" in str(exc):
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result


@router.get("/{table_name}/indexes")
async def list_indexes_endpoint(
    table_name: str,
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, str]]:
    """List all vector indexes on a table."""
    # Verify table exists
    await _get_column_meta(session, table_name)

    return await list_indexes(session, table_name)


@router.delete("/{table_name}/indexes/{index_name}", status_code=204)
async def drop_index_endpoint(
    table_name: str,
    index_name: str,
    session: AsyncSession = Depends(get_project_session),
) -> None:
    """Drop a vector index from a table."""
    try:
        await drop_index(session, table_name, index_name)
    except IdxError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
