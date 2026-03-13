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
from pqdb_api.models.project import Project
from pqdb_api.services.api_keys import list_project_keys, rotate_project_keys

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
