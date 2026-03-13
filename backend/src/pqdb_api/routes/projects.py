"""Project CRUD endpoints: create, list, get, delete."""

import uuid
from datetime import datetime
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project
from pqdb_api.services.api_keys import create_project_keys
from pqdb_api.services.provisioner import provision_database

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    """Request body for creating a project."""

    name: str
    region: str = "us-east-1"


class ApiKeyCreatedResponse(BaseModel):
    """API key info returned at creation time (includes full key)."""

    id: str
    role: str
    key: str
    key_prefix: str


class ProjectResponse(BaseModel):
    """Response body for a project."""

    id: str
    name: str
    region: str
    status: str
    database_name: str | None = None
    created_at: datetime


class ProjectCreateResponse(ProjectResponse):
    """Response body for project creation (includes one-time API keys)."""

    api_keys: list[ApiKeyCreatedResponse]


def _project_response(p: Project) -> ProjectResponse:
    return ProjectResponse(
        id=str(p.id),
        name=p.name,
        region=p.region,
        status=p.status,
        database_name=p.database_name,
        created_at=p.created_at,
    )


@router.post("", response_model=ProjectCreateResponse, status_code=201)
async def create_project(
    body: CreateProjectRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Create a new project for the authenticated developer."""
    project = Project(
        id=uuid.uuid4(),
        developer_id=developer_id,
        name=body.name,
        region=body.region,
    )
    session.add(project)
    await session.flush()

    keys = await create_project_keys(project.id, session)
    await session.commit()
    await session.refresh(project)

    # Provision an isolated database for the project
    database_url: str = request.app.state.settings.database_url
    try:
        result = await provision_database(project.id, database_url)
        project.database_name = result.database_name
        project.status = "active"
        await session.commit()
        await session.refresh(project)
    except Exception:
        logger.exception(
            "provisioning_failed",
            project_id=str(project.id),
        )
        project.status = "provisioning_failed"
        await session.commit()
        await session.refresh(project)

    logger.info(
        "project_created",
        project_id=str(project.id),
        developer_id=str(developer_id),
        database_name=project.database_name,
    )
    return {
        "id": str(project.id),
        "name": project.name,
        "region": project.region,
        "status": project.status,
        "database_name": project.database_name,
        "created_at": project.created_at,
        "api_keys": [
            {
                "id": k["id"],
                "role": k["role"],
                "key": k["key"],
                "key_prefix": k["key_prefix"],
            }
            for k in keys
        ],
    }


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> list[ProjectResponse]:
    """List all active projects for the authenticated developer."""
    result = await session.execute(
        select(Project).where(
            Project.developer_id == developer_id,
            Project.status != "archived",
        )
    )
    projects = result.scalars().all()
    return [_project_response(p) for p in projects]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    """Get a project by ID, scoped to the authenticated developer."""
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_response(project)


@router.delete("/{project_id}", response_model=ProjectResponse)
async def delete_project(
    project_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    """Soft-delete a project by setting its status to archived."""
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    project.status = "archived"
    await session.commit()
    await session.refresh(project)
    logger.info(
        "project_deleted",
        project_id=str(project.id),
        developer_id=str(developer_id),
    )
    return _project_response(project)
