"""API key endpoints: list, rotate, create scoped, and delete project keys."""

import uuid
from datetime import datetime
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project
from pqdb_api.services.api_keys import (
    create_scoped_key,
    create_single_key,
    delete_project_key,
    list_project_keys,
    rotate_project_keys,
    validate_permissions,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["api-keys"])


class ApiKeyListResponse(BaseModel):
    """Response for listing API keys (prefix only, no full key)."""

    id: str
    role: str
    key_prefix: str
    created_at: datetime
    name: str | None = None
    permissions: dict[str, Any] | None = None


class ApiKeyCreatedResponse(BaseModel):
    """Response for newly created keys (includes full key, one-time display)."""

    id: str
    role: str
    key: str
    key_prefix: str


class ScopedKeyRequest(BaseModel):
    """Request body for creating a scoped API key."""

    name: str
    permissions: dict[str, Any]


class ScopedKeyCreatedResponse(BaseModel):
    """Response for newly created scoped key (includes full key, one-time display)."""

    id: str
    role: str
    name: str
    key: str
    key_prefix: str
    permissions: dict[str, Any]


async def _get_project_for_developer(
    project_id: uuid.UUID,
    developer_id: uuid.UUID,
    session: AsyncSession,
) -> Project:
    """Fetch a project scoped to a developer, raising 404 if not found."""
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get(
    "/{project_id}/keys",
    response_model=list[ApiKeyListResponse],
)
async def list_keys(
    project_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> list[ApiKeyListResponse]:
    """List API keys for a project (shows prefix only, not full key)."""
    await _get_project_for_developer(project_id, developer_id, session)

    keys = await list_project_keys(project_id, session)
    return [
        ApiKeyListResponse(
            id=str(k.id),
            role=k.role,
            key_prefix=k.key_prefix,
            created_at=k.created_at,
            name=k.name,
            permissions=k.permissions,
        )
        for k in keys
    ]


@router.post(
    "/{project_id}/keys/service-key",
    response_model=ApiKeyCreatedResponse,
)
async def generate_service_key(
    project_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> ApiKeyCreatedResponse:
    """Create a service API key for Dashboard/MCP use.

    Always creates a new key — multiple consumers (dashboard, MCP server)
    each need their own key. Deleting old keys would invalidate other
    active sessions.
    Returns the full key (one-time display). Requires developer JWT.
    """
    await _get_project_for_developer(project_id, developer_id, session)

    key_info = await create_single_key(project_id, "service", session)
    await session.commit()

    logger.info(
        "service_key_generated",
        project_id=str(project_id),
        developer_id=str(developer_id),
    )
    return ApiKeyCreatedResponse(
        id=key_info["id"],
        role=key_info["role"],
        key=key_info["key"],
        key_prefix=key_info["key_prefix"],
    )


@router.post(
    "/{project_id}/keys/rotate",
    response_model=list[ApiKeyCreatedResponse],
)
async def rotate_keys(
    project_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> list[ApiKeyCreatedResponse]:
    """Rotate API keys for a project. Returns new full keys (one-time display)."""
    await _get_project_for_developer(project_id, developer_id, session)

    new_keys = await rotate_project_keys(project_id, session)
    await session.commit()

    logger.info(
        "api_keys_rotated",
        project_id=str(project_id),
        developer_id=str(developer_id),
    )
    return [
        ApiKeyCreatedResponse(
            id=k["id"],
            role=k["role"],
            key=k["key"],
            key_prefix=k["key_prefix"],
        )
        for k in new_keys
    ]


@router.post(
    "/{project_id}/keys/scoped",
    response_model=ScopedKeyCreatedResponse,
    status_code=201,
)
async def create_scoped_api_key(
    project_id: uuid.UUID,
    body: ScopedKeyRequest,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> ScopedKeyCreatedResponse:
    """Create a scoped API key with table-level permissions.

    Returns the full key (one-time display). Requires developer JWT.
    """
    await _get_project_for_developer(project_id, developer_id, session)

    error = validate_permissions(body.permissions)
    if error is not None:
        raise HTTPException(status_code=422, detail=error)

    key_info = await create_scoped_key(
        project_id, body.name, body.permissions, session
    )
    await session.commit()

    logger.info(
        "scoped_key_created",
        project_id=str(project_id),
        developer_id=str(developer_id),
        key_name=body.name,
    )
    return ScopedKeyCreatedResponse(
        id=str(key_info["id"]),
        role="scoped",
        name=body.name,
        key=str(key_info["key"]),
        key_prefix=str(key_info["key_prefix"]),
        permissions=body.permissions,
    )


@router.delete(
    "/{project_id}/keys/{key_id}",
    status_code=204,
)
async def delete_key(
    project_id: uuid.UUID,
    key_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete a specific API key from a project."""
    await _get_project_for_developer(project_id, developer_id, session)

    deleted = await delete_project_key(project_id, key_id, session)
    if not deleted:
        raise HTTPException(status_code=404, detail="API key not found")

    await session.commit()

    logger.info(
        "api_key_deleted",
        project_id=str(project_id),
        developer_id=str(developer_id),
        key_id=str(key_id),
    )
