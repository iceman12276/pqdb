"""Custom roles endpoints for project developers (US-040).

POST   /v1/projects/{project_id}/auth/roles          — create custom role
GET    /v1/projects/{project_id}/auth/roles           — list all roles
DELETE /v1/projects/{project_id}/auth/roles/{name}    — delete custom role

Requires developer JWT. Roles are scoped to project databases.
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
from pqdb_api.services.auth_engine import ensure_auth_tables
from pqdb_api.services.roles_policies import (
    create_role,
    delete_role,
    list_roles,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["roles"])


class CreateRoleRequest(BaseModel):
    """Request body for creating a custom role."""

    name: str
    description: str | None = None


class RoleResponse(BaseModel):
    """Single role response."""

    id: str
    name: str
    description: str | None
    created_at: str | None = None


async def _get_project_session(
    project_id: uuid.UUID,
    developer_id: uuid.UUID,
    request: Request,
    session: AsyncSession,
) -> AsyncSession:
    """Get a project-scoped database session after verifying ownership.

    Returns an AsyncSession connected to the project database.
    Raises HTTPException if project not found or not provisioned.
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
        raise HTTPException(status_code=400, detail="Project database not provisioned")

    platform_url: str = request.app.state.settings.database_url
    last_slash = platform_url.rfind("/")
    if last_slash == -1:
        raise HTTPException(status_code=500, detail="Invalid database URL")
    project_url = platform_url[: last_slash + 1] + project.database_name

    engine = _get_or_create_engine(
        request.app.state, project_url, project.database_name
    )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return factory()


@router.post(
    "/{project_id}/auth/roles",
    status_code=201,
)
async def create_role_endpoint(
    project_id: uuid.UUID,
    body: CreateRoleRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Create a custom role in a project."""
    project_session = await _get_project_session(
        project_id, developer_id, request, session
    )
    try:
        await ensure_auth_tables(project_session)
        role = await create_role(project_session, body.name, body.description)
        return role
    except ValueError as exc:
        msg = str(exc)
        if "reserved" in msg or "already exists" in msg:
            raise HTTPException(status_code=409, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
    finally:
        await project_session.close()


@router.get("/{project_id}/auth/roles")
async def list_roles_endpoint(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """List all roles (built-in + custom) in a project."""
    project_session = await _get_project_session(
        project_id, developer_id, request, session
    )
    try:
        await ensure_auth_tables(project_session)
        return await list_roles(project_session)
    finally:
        await project_session.close()


@router.delete(
    "/{project_id}/auth/roles/{role_name}",
    status_code=204,
)
async def delete_role_endpoint(
    project_id: uuid.UUID,
    role_name: str,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete a custom role and all associated policies."""
    project_session = await _get_project_session(
        project_id, developer_id, request, session
    )
    try:
        await ensure_auth_tables(project_session)
        await delete_role(project_session, role_name)
    except ValueError as exc:
        msg = str(exc)
        if "Cannot delete built-in" in msg:
            raise HTTPException(status_code=400, detail=msg) from exc
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
    finally:
        await project_session.close()
