"""Project CRUD endpoints: create, list, get, delete."""

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

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    """Request body for creating a project."""

    name: str
    region: str = "us-east-1"


class ProjectResponse(BaseModel):
    """Response body for a project."""

    id: str
    name: str
    region: str
    status: str
    created_at: datetime


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(
    body: CreateProjectRequest,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    """Create a new project for the authenticated developer."""
    project = Project(
        id=uuid.uuid4(),
        developer_id=developer_id,
        name=body.name,
        region=body.region,
    )
    session.add(project)
    await session.commit()
    await session.refresh(project)
    logger.info(
        "project_created",
        project_id=str(project.id),
        developer_id=str(developer_id),
    )
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        region=project.region,
        status=project.status,
        created_at=project.created_at,
    )


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
    return [
        ProjectResponse(
            id=str(p.id),
            name=p.name,
            region=p.region,
            status=p.status,
            created_at=p.created_at,
        )
        for p in projects
    ]


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
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        region=project.region,
        status=project.status,
        created_at=project.created_at,
    )


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
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        region=project.region,
        status=project.status,
        created_at=project.created_at,
    )
