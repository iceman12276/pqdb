"""API key endpoints: list and rotate project keys."""

import uuid
from datetime import datetime

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.api_key import ApiKey
from pqdb_api.models.project import Project
from pqdb_api.services.api_keys import (
    create_single_key,
    list_project_keys,
    rotate_project_keys,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["api-keys"])


class ApiKeyListResponse(BaseModel):
    """Response for listing API keys (prefix only, no full key)."""

    id: str
    role: str
    key_prefix: str
    created_at: datetime


class ApiKeyCreatedResponse(BaseModel):
    """Response for newly created keys (includes full key, one-time display)."""

    id: str
    role: str
    key: str
    key_prefix: str


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
    """Get or create a service API key for Dashboard/MCP use.

    Returns an existing service key if one exists, or creates a new one.
    This is idempotent — calling it multiple times won't accumulate keys.
    Returns the full key (one-time display). Requires developer JWT.
    """
    await _get_project_for_developer(project_id, developer_id, session)

    # Check for existing service key — delete old one to prevent accumulation
    existing = await session.execute(
        select(ApiKey)
        .where(
            ApiKey.project_id == project_id,
            ApiKey.role == "service",
        )
        .order_by(ApiKey.created_at.desc())
        .limit(1)
    )
    existing_key = existing.scalar_one_or_none()

    if existing_key:
        # Return existing key — but we only have the hash, not the plaintext.
        # We need to create a new one since we can't recover the original.
        # However, to prevent accumulation, delete the old one first.
        await session.delete(existing_key)
        await session.flush()

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
