"""Branch CRUD endpoints: create, list, and delete database branches."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.branch import DatabaseBranch, validate_branch_name
from pqdb_api.models.project import Project
from pqdb_api.services.branching import (
    BranchingError,
    BranchLimitExceededError,
    check_branch_limit,
    create_branch_database,
    drop_branch_database,
    make_branch_database_name,
)
from pqdb_api.services.provisioner import make_project_user

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["branches"])


class CreateBranchRequest(BaseModel):
    """Request body for creating a branch."""

    name: str


class BranchResponse(BaseModel):
    """Response body for a branch."""

    id: str
    name: str
    database_name: str
    status: str
    created_at: datetime


def _branch_response(branch: DatabaseBranch) -> BranchResponse:
    return BranchResponse(
        id=str(branch.id),
        name=branch.name,
        database_name=branch.database_name,
        status=branch.status,
        created_at=branch.created_at,
    )


async def _get_owned_project(
    project_id: uuid.UUID,
    developer_id: uuid.UUID,
    session: AsyncSession,
) -> Project:
    """Load a project owned by the developer or raise 404."""
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
        raise HTTPException(status_code=400, detail="Project not provisioned")
    return project


@router.post(
    "/{project_id}/branches",
    response_model=BranchResponse,
    status_code=201,
)
async def create_branch(
    project_id: uuid.UUID,
    body: CreateBranchRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Create a database branch from the project's main database.

    Uses CREATE DATABASE ... TEMPLATE which requires terminating
    active connections to the source database. The branch reuses
    the project's existing Postgres user and HMAC key.
    """
    if not validate_branch_name(body.name):
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "INVALID_BRANCH_NAME",
                    "message": (
                        "Branch name must match ^[a-z][a-z0-9_-]{0,62}$ "
                        "and not be a reserved name."
                    ),
                }
            },
        )

    project = await _get_owned_project(project_id, developer_id, session)
    assert project.database_name is not None

    # Check branch limit
    try:
        await check_branch_limit(session, project_id)
    except BranchLimitExceededError:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "BRANCH_LIMIT_EXCEEDED",
                    "message": "Maximum 5 branches per project.",
                }
            },
        )

    # Check for duplicate branch name
    existing = await session.execute(
        select(DatabaseBranch).where(
            DatabaseBranch.project_id == project_id,
            DatabaseBranch.name == body.name,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "BRANCH_EXISTS",
                    "message": f"Branch '{body.name}' already exists.",
                }
            },
        )

    branch_id = uuid.uuid4()
    branch_db_name = make_branch_database_name(branch_id)
    project_user = make_project_user(project_id)

    # Create the branch database via superuser
    provisioner = request.app.state.provisioner
    try:
        await create_branch_database(
            superuser_dsn=provisioner.superuser_dsn,
            branch_db_name=branch_db_name,
            template_db_name=project.database_name,
            project_user=project_user,
        )
    except BranchingError as exc:
        logger.error(
            "branch_creation_failed",
            project_id=str(project_id),
            branch_name=body.name,
            error=str(exc),
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to create branch database",
        )

    # Record branch metadata
    branch = DatabaseBranch(
        id=branch_id,
        project_id=project_id,
        name=body.name,
        database_name=branch_db_name,
        parent_database=project.database_name,
    )
    session.add(branch)
    await session.commit()
    await session.refresh(branch)

    logger.info(
        "branch_created",
        project_id=str(project_id),
        branch_id=str(branch_id),
        branch_name=body.name,
        database_name=branch_db_name,
    )

    return {
        "id": str(branch.id),
        "name": branch.name,
        "database_name": branch.database_name,
        "status": branch.status,
        "created_at": branch.created_at,
    }


@router.get(
    "/{project_id}/branches",
    response_model=list[BranchResponse],
)
async def list_branches(
    project_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> list[BranchResponse]:
    """List all non-deleted branches for a project."""
    await _get_owned_project(project_id, developer_id, session)

    result = await session.execute(
        select(DatabaseBranch).where(
            DatabaseBranch.project_id == project_id,
        )
    )
    branches = result.scalars().all()
    return [_branch_response(b) for b in branches]


@router.delete("/{project_id}/branches/{branch_name}")
async def delete_branch(
    project_id: uuid.UUID,
    branch_name: str,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Delete a branch: drop the database, evict engine cache, delete metadata."""
    await _get_owned_project(project_id, developer_id, session)

    result = await session.execute(
        select(DatabaseBranch).where(
            DatabaseBranch.project_id == project_id,
            DatabaseBranch.name == branch_name,
        )
    )
    branch = result.scalar_one_or_none()
    if branch is None:
        raise HTTPException(status_code=404, detail="Branch not found")

    # Drop the branch database
    provisioner = request.app.state.provisioner
    try:
        await drop_branch_database(
            superuser_dsn=provisioner.superuser_dsn,
            branch_db_name=branch.database_name,
        )
    except BranchingError as exc:
        logger.error(
            "branch_drop_failed",
            project_id=str(project_id),
            branch_name=branch_name,
            error=str(exc),
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to drop branch database",
        )

    # Evict engine from cache
    engines: dict[str, AsyncEngine] = getattr(request.app.state, "project_engines", {})
    engine = engines.pop(branch.database_name, None)
    if engine is not None:
        await engine.dispose()

    # Hard delete — the database is already dropped, no point keeping metadata
    await session.delete(branch)
    await session.commit()

    logger.info(
        "branch_deleted",
        project_id=str(project_id),
        branch_name=branch_name,
        database_name=branch.database_name,
    )

    return {"status": "deleted"}
