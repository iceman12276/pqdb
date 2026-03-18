"""Project CRUD endpoints: create, list, get, delete, HMAC key, reindex."""

import secrets
import uuid
from datetime import datetime
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
from pqdb_api.middleware.api_key import (
    _build_project_database_url,
    _get_or_create_engine,
)
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project
from pqdb_api.services.api_keys import create_project_keys
from pqdb_api.services.provisioner import DatabaseProvisioner, ProvisioningError
from pqdb_api.services.rate_limiter import RateLimiter, RateLimitResult
from pqdb_api.services.reindex import (
    ReindexError,
    apply_reindex_batch,
    complete_reindex_job,
    get_job_status,
    get_latest_job_status,
    start_reindex,
)
from pqdb_api.services.vault import VaultClient, VaultError, VersionedHmacKeys

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


def _project_response(project: Project) -> ProjectResponse:
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        region=project.region,
        status=project.status,
        database_name=project.database_name,
        created_at=project.created_at,
    )


@router.post("", response_model=ProjectCreateResponse, status_code=201)
async def create_project(
    body: CreateProjectRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Create a new project and provision an isolated database."""
    project = Project(
        id=uuid.uuid4(),
        developer_id=developer_id,
        name=body.name,
        region=body.region,
        status="provisioning",
    )
    session.add(project)
    await session.flush()

    keys = await create_project_keys(project.id, session)
    await session.commit()
    await session.refresh(project)

    provisioner: DatabaseProvisioner = request.app.state.provisioner
    try:
        db_name = await provisioner.provision(project.id)
        project.database_name = db_name
        project.status = "active"
    except ProvisioningError as exc:
        logger.error(
            "project_provisioning_failed",
            project_id=str(project.id),
            error=str(exc),
        )
        project.status = "provisioning_failed"

    # Generate and store HMAC key in Vault
    if project.status == "active":
        vault_client: VaultClient = request.app.state.vault_client
        hmac_key = secrets.token_bytes(32)
        try:
            vault_client.store_hmac_key(project.id, hmac_key)
        except VaultError as exc:
            logger.error(
                "hmac_key_storage_failed",
                project_id=str(project.id),
                error=str(exc),
            )
            project.status = "hmac_failed"

    await session.commit()
    await session.refresh(project)

    logger.info(
        "project_created",
        project_id=str(project.id),
        developer_id=str(developer_id),
        status=project.status,
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
    """Soft-delete a project by setting its status to archived.

    Does NOT drop the provisioned database (soft delete for MVP).
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
    project.status = "archived"
    await session.commit()
    await session.refresh(project)
    logger.info(
        "project_deleted",
        project_id=str(project.id),
        developer_id=str(developer_id),
    )
    return _project_response(project)


class HmacKeyResponse(BaseModel):
    """Response body for HMAC key retrieval (versioned)."""

    current_version: int
    keys: dict[str, str]


class HmacKeyRotateResponse(BaseModel):
    """Response body for HMAC key rotation."""

    previous_version: int
    current_version: int


@router.get("/{project_id}/hmac-key", response_model=HmacKeyResponse)
async def get_hmac_key(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> HmacKeyResponse:
    """Retrieve all HMAC keys for a project with version metadata.

    Requires developer JWT. Rate-limited to 10 requests/minute per project.
    Returns all active keys so the SDK can decrypt data encrypted with any version.
    """
    # Verify project exists and belongs to the developer
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Rate limiting using consolidated RateLimiter
    rate_limiter: RateLimiter = request.app.state.hmac_rate_limiter
    rl_result: RateLimitResult = rate_limiter.check(project_id)
    if not rl_result.allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "error": {
                    "code": "rate_limited",
                    "message": "Too many requests. Try again later.",
                }
            },
        )

    # Retrieve all keys from Vault
    vault_client: VaultClient = request.app.state.vault_client
    try:
        versioned_keys: VersionedHmacKeys = vault_client.get_hmac_keys(project_id)
    except VaultError:
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve HMAC key",
        )

    return HmacKeyResponse(
        current_version=versioned_keys.current_version,
        keys=versioned_keys.keys,
    )


@router.post(
    "/{project_id}/hmac-key/rotate",
    response_model=HmacKeyRotateResponse,
)
async def rotate_hmac_key(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> HmacKeyRotateResponse:
    """Rotate the HMAC key for a project.

    Generates a new 256-bit key, adds as next version in Vault,
    updates current_version. Requires developer JWT (project owner only).
    """
    # Verify project exists and belongs to the developer
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    vault_client: VaultClient = request.app.state.vault_client
    try:
        versioned_keys = vault_client.rotate_hmac_key(project_id)
    except VaultError:
        raise HTTPException(
            status_code=500,
            detail="Failed to rotate HMAC key",
        )

    previous_version = versioned_keys.current_version - 1
    return HmacKeyRotateResponse(
        previous_version=previous_version,
        current_version=versioned_keys.current_version,
    )


async def _get_project_session(request: Request, project: Project) -> AsyncSession:
    """Create a session connected to the project's database.

    If app.state has a _test_project_session_factory, uses it instead
    of building a real project-scoped connection. This allows integration
    tests to route project sessions to the test database.
    """
    test_factory = getattr(request.app.state, "_test_project_session_factory", None)
    if test_factory is not None:
        session: AsyncSession = test_factory()
        return session
    assert project.database_name is not None
    settings = request.app.state.settings
    db_name: str = project.database_name
    project_db_url = _build_project_database_url(settings.database_url, db_name)
    engine = _get_or_create_engine(request.app.state, project_db_url, db_name)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return factory()


@router.post("/{project_id}/reindex", status_code=202)
async def start_reindex_endpoint(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Start an SDK-driven re-indexing job for a project.

    Returns { job_id, tables } where tables lists the tables and their
    searchable columns that need re-indexing. The SDK uses this info to
    fetch rows, decrypt, re-compute blind indexes, and send them back
    via POST /reindex/batch.

    Requires developer JWT (project owner only).
    Returns 409 if a job is already running.
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
        raise HTTPException(status_code=400, detail="Project not provisioned")

    project_session = await _get_project_session(request, project)
    try:
        job_result = await start_reindex(project_session, project_id)
        return job_result
    except ReindexError as exc:
        if "conflict" in str(exc).lower():
            raise HTTPException(
                status_code=409,
                detail="A re-index job is already running",
            )
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        await project_session.close()


class ReindexBatchUpdate(BaseModel):
    """A single row's index updates."""

    id: str
    indexes: dict[str, str]


class ReindexBatchRequest(BaseModel):
    """Request body for reindex batch endpoint."""

    job_id: str
    table: str
    updates: list[ReindexBatchUpdate]


@router.post("/{project_id}/reindex/batch")
async def reindex_batch_endpoint(
    project_id: uuid.UUID,
    body: ReindexBatchRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Accept SDK-computed blind index updates for a table.

    The SDK decrypts encrypted values, re-computes HMAC(new_key, plaintext),
    and sends the updated indexes here. The server stores them directly.
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
        raise HTTPException(status_code=400, detail="Project not provisioned")

    job_id = uuid.UUID(body.job_id)

    project_session = await _get_project_session(request, project)
    try:
        # Verify job exists and is running
        job_status = await get_job_status(project_session, job_id)
        if job_status is None:
            raise HTTPException(status_code=404, detail="Re-index job not found")
        if job_status["status"] != "running":
            raise HTTPException(status_code=400, detail="Re-index job is not running")

        updates_dicts = [{"id": u.id, "indexes": u.indexes} for u in body.updates]
        rows_updated = await apply_reindex_batch(
            project_session, job_id, body.table, updates_dicts
        )
        return {"rows_updated": rows_updated}
    finally:
        await project_session.close()


class ReindexCompleteRequest(BaseModel):
    """Request body for marking a reindex job complete."""

    job_id: str
    tables_done: int


@router.post("/{project_id}/reindex/complete")
async def reindex_complete_endpoint(
    project_id: uuid.UUID,
    body: ReindexCompleteRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Mark a re-index job as complete. Called by the SDK when all batches are done."""
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

    job_id = uuid.UUID(body.job_id)

    project_session = await _get_project_session(request, project)
    try:
        job_status = await get_job_status(project_session, job_id)
        if job_status is None:
            raise HTTPException(status_code=404, detail="Re-index job not found")
        if job_status["status"] != "running":
            raise HTTPException(status_code=400, detail="Re-index job is not running")

        await complete_reindex_job(project_session, job_id, body.tables_done)
        return {"status": "complete"}
    finally:
        await project_session.close()


@router.get("/{project_id}/reindex/status")
async def get_reindex_status(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Get the status of the latest re-indexing job for a project."""
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

    project_session = await _get_project_session(request, project)
    try:
        status = await get_latest_job_status(project_session)
        if status is None:
            raise HTTPException(
                status_code=404,
                detail="No re-index jobs found",
            )
        return status
    finally:
        await project_session.close()


@router.delete("/{project_id}/hmac-key/versions/{version}")
async def delete_hmac_key_version(
    project_id: uuid.UUID,
    version: int,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Delete an old HMAC key version after successful re-indexing.

    Cannot delete the current version. Requires developer JWT (project owner only).
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

    vault_client: VaultClient = request.app.state.vault_client
    try:
        updated_keys = vault_client.delete_hmac_key_version(project_id, version)
    except VaultError as exc:
        msg = str(exc)
        if "Cannot delete current" in msg:
            raise HTTPException(status_code=400, detail=msg)
        if "not found" in msg.lower():
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=500, detail=msg)

    return {
        "current_version": updated_keys.current_version,
        "remaining_versions": list(updated_keys.keys.keys()),
    }
