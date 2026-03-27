"""Branch CRUD + promote/rebase/reset endpoints."""

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
    BRANCH_STATUS_ACTIVE,
    BRANCH_STATUS_MERGING,
    BRANCH_STATUS_REBASING,
    BranchingError,
    BranchLimitExceededError,
    check_branch_limit,
    create_branch_database,
    drop_branch_database,
    get_active_connection_count,
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


class PromoteRequest(BaseModel):
    """Request body for promoting a branch to main."""

    force: bool = False


class PromoteResponse(BaseModel):
    """Response body after promoting a branch."""

    status: str
    old_database: str
    new_database: str
    stale_branches: list[str]


class RebaseResponse(BaseModel):
    """Response body after rebasing/resetting a branch."""

    status: str
    name: str
    database_name: str


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


async def _get_active_branch(
    project_id: uuid.UUID,
    branch_name: str,
    session: AsyncSession,
) -> DatabaseBranch:
    """Load a branch by name or raise 404. Reject non-active branches with 409."""
    result = await session.execute(
        select(DatabaseBranch).where(
            DatabaseBranch.project_id == project_id,
            DatabaseBranch.name == branch_name,
        )
    )
    branch = result.scalar_one_or_none()
    if branch is None:
        raise HTTPException(status_code=404, detail="Branch not found")
    if branch.status != BRANCH_STATUS_ACTIVE:
        raise HTTPException(
            status_code=409,
            detail=f"Branch '{branch_name}' is currently {branch.status}",
        )
    return branch


def _evict_engine(request: Request, db_name: str) -> None:
    """Evict and dispose a cached engine for a database name."""
    engines: dict[str, AsyncEngine] = getattr(request.app.state, "project_engines", {})
    engine = engines.pop(db_name, None)
    if engine is not None:
        import asyncio

        asyncio.get_event_loop().create_task(engine.dispose())


@router.post(
    "/{project_id}/branches/{branch_name}/promote",
    response_model=PromoteResponse,
)
async def promote_branch(
    project_id: uuid.UUID,
    branch_name: str,
    request: Request,
    body: PromoteRequest | None = None,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Promote a branch to main.

    1. Check for active connections (reject with 409 unless force=true)
    2. Set branch status to 'merging'
    3. Evict engines for old main + branch
    4. Update Project.database_name to branch DB
    5. Drop old main DB
    6. Delete branch metadata row
    7. Return list of stale branches
    """
    force = body.force if body is not None else False

    project = await _get_owned_project(project_id, developer_id, session)
    assert project.database_name is not None
    old_main_db = project.database_name

    branch = await _get_active_branch(project_id, branch_name, session)

    # Check active connections unless force=true
    if not force:
        provisioner = request.app.state.provisioner
        try:
            conn_count = await get_active_connection_count(
                superuser_dsn=provisioner.superuser_dsn,
                database_name=old_main_db,
            )
            branch_conn_count = await get_active_connection_count(
                superuser_dsn=provisioner.superuser_dsn,
                database_name=branch.database_name,
            )
            total = conn_count + branch_conn_count
        except BranchingError:
            total = 0
        if total > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot promote: {total} active connection(s). "
                f"Use force=true to proceed.",
            )

    # Race-condition guard: set status to merging
    branch.status = BRANCH_STATUS_MERGING
    await session.commit()

    # Evict engines
    _evict_engine(request, old_main_db)
    _evict_engine(request, branch.database_name)

    # Update project to point to branch database
    project.database_name = branch.database_name
    await session.commit()

    # Drop old main database
    provisioner = request.app.state.provisioner
    try:
        await drop_branch_database(
            superuser_dsn=provisioner.superuser_dsn,
            branch_db_name=old_main_db,
        )
    except BranchingError as exc:
        logger.error(
            "promote_drop_old_main_failed",
            project_id=str(project_id),
            old_main_db=old_main_db,
            error=str(exc),
        )
        # Continue — the project already points to the new DB

    # Find stale branches (other branches still pointing at old parent)
    stale_result = await session.execute(
        select(DatabaseBranch).where(
            DatabaseBranch.project_id == project_id,
            DatabaseBranch.id != branch.id,
        )
    )
    stale_branches = [b.name for b in stale_result.scalars().all()]

    # Delete the promoted branch metadata
    await session.delete(branch)
    await session.commit()

    logger.info(
        "branch_promoted",
        project_id=str(project_id),
        branch_name=branch_name,
        old_database=old_main_db,
        new_database=project.database_name,
        stale_branches=stale_branches,
    )

    return {
        "status": "promoted",
        "old_database": old_main_db,
        "new_database": project.database_name,
        "stale_branches": stale_branches,
    }


async def _rebase_branch_handler(
    project_id: uuid.UUID,
    branch_name: str,
    request: Request,
    developer_id: uuid.UUID,
    session: AsyncSession,
) -> dict[str, Any]:
    """Shared handler for rebase and reset endpoints.

    1. Set branch status to 'rebasing'
    2. Evict engine for branch DB
    3. Drop branch DB
    4. Re-clone from current main via CREATE DATABASE...TEMPLATE
    5. Reset status to 'active'
    """
    project = await _get_owned_project(project_id, developer_id, session)
    assert project.database_name is not None

    branch = await _get_active_branch(project_id, branch_name, session)

    # Race-condition guard
    branch.status = BRANCH_STATUS_REBASING
    await session.commit()

    # Evict engine
    _evict_engine(request, branch.database_name)

    provisioner = request.app.state.provisioner
    project_user = make_project_user(project_id)

    try:
        # Drop branch DB
        await drop_branch_database(
            superuser_dsn=provisioner.superuser_dsn,
            branch_db_name=branch.database_name,
        )
        # Re-clone from current main
        await create_branch_database(
            superuser_dsn=provisioner.superuser_dsn,
            branch_db_name=branch.database_name,
            template_db_name=project.database_name,
            project_user=project_user,
        )
    except BranchingError as exc:
        logger.error(
            "branch_rebase_failed",
            project_id=str(project_id),
            branch_name=branch_name,
            error=str(exc),
        )
        # Restore status so it's not stuck in rebasing
        branch.status = BRANCH_STATUS_ACTIVE
        await session.commit()
        raise HTTPException(
            status_code=500,
            detail="Failed to rebase branch database",
        )

    # Update parent_database to current main and reset status
    branch.parent_database = project.database_name
    branch.status = BRANCH_STATUS_ACTIVE
    await session.commit()

    logger.info(
        "branch_rebased",
        project_id=str(project_id),
        branch_name=branch_name,
        database_name=branch.database_name,
    )

    return {
        "status": "rebased",
        "name": branch.name,
        "database_name": branch.database_name,
    }


@router.post(
    "/{project_id}/branches/{branch_name}/rebase",
    response_model=RebaseResponse,
)
async def rebase_branch(
    project_id: uuid.UUID,
    branch_name: str,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Rebase: drop the branch DB and re-clone from current main."""
    return await _rebase_branch_handler(
        project_id, branch_name, request, developer_id, session
    )


@router.post(
    "/{project_id}/branches/{branch_name}/reset",
    response_model=RebaseResponse,
)
async def reset_branch(
    project_id: uuid.UUID,
    branch_name: str,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Reset: alias for rebase — drop and re-clone from current main."""
    return await _rebase_branch_handler(
        project_id, branch_name, request, developer_id, session
    )
