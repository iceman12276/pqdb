"""Auth settings endpoints for project owners.

GET/POST /v1/projects/{project_id}/auth/settings
Requires developer JWT. Project must belong to the authenticated developer.
"""

from __future__ import annotations

import uuid
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
)

from pqdb_api.database import get_session
from pqdb_api.middleware.api_key import _get_or_create_engine
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project
from pqdb_api.services.auth_engine import (
    ensure_auth_tables,
    get_auth_settings,
    update_auth_settings,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["auth-settings"])


class AuthSettingsResponse(BaseModel):
    """Auth settings response body."""

    require_email_verification: bool
    magic_link_webhook: str | None
    password_min_length: int
    mfa_enabled: bool


class UpdateAuthSettingsRequest(BaseModel):
    """Request body for updating auth settings."""

    require_email_verification: bool | None = None
    magic_link_webhook: str | None = None
    password_min_length: int | None = None
    mfa_enabled: bool | None = None


async def _get_project_for_developer(
    project_id: uuid.UUID,
    developer_id: uuid.UUID,
    session: AsyncSession,
) -> Project:
    """Fetch a project, verifying it belongs to the developer.

    Raises HTTPException 404 if not found or not owned.
    """
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.database_name is None:
        raise HTTPException(
            status_code=400,
            detail="Project database not provisioned",
        )
    return project


def _build_project_db_url(platform_url: str, database_name: str) -> str:
    """Swap the database name in a platform URL."""
    last_slash = platform_url.rfind("/")
    if last_slash == -1:
        raise ValueError("Invalid platform database URL")
    return platform_url[: last_slash + 1] + database_name


@router.get(
    "/{project_id}/auth/settings",
    response_model=AuthSettingsResponse,
)
async def get_project_auth_settings(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> AuthSettingsResponse:
    """Get auth settings for a project.

    Requires developer JWT. Lazily initializes auth tables if needed.
    """
    project = await _get_project_for_developer(project_id, developer_id, session)
    assert project.database_name is not None  # guarded above

    platform_url: str = request.app.state.settings.database_url
    project_url = _build_project_db_url(platform_url, project.database_name)
    engine = _get_or_create_engine(
        request.app.state, project_url, project.database_name
    )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as project_session:
        await ensure_auth_tables(project_session)
        settings = await get_auth_settings(project_session)

    return AuthSettingsResponse(**settings)


@router.post(
    "/{project_id}/auth/settings",
    response_model=AuthSettingsResponse,
)
async def update_project_auth_settings(
    project_id: uuid.UUID,
    body: UpdateAuthSettingsRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> AuthSettingsResponse:
    """Update auth settings for a project.

    Requires developer JWT. Only provided fields are updated.
    """
    project = await _get_project_for_developer(project_id, developer_id, session)
    assert project.database_name is not None  # guarded above

    # Build updates dict from non-None fields
    updates: dict[str, Any] = {}
    if body.require_email_verification is not None:
        updates["require_email_verification"] = body.require_email_verification
    if body.magic_link_webhook is not None:
        updates["magic_link_webhook"] = body.magic_link_webhook
    if body.password_min_length is not None:
        updates["password_min_length"] = body.password_min_length
    if body.mfa_enabled is not None:
        updates["mfa_enabled"] = body.mfa_enabled

    platform_url: str = request.app.state.settings.database_url
    project_url = _build_project_db_url(platform_url, project.database_name)
    engine = _get_or_create_engine(
        request.app.state, project_url, project.database_name
    )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with factory() as project_session:
            settings = await update_auth_settings(project_session, updates)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return AuthSettingsResponse(**settings)
