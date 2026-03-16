"""OAuth provider CRUD endpoints for project owners.

POST   /v1/projects/{project_id}/auth/providers — configure a provider
GET    /v1/projects/{project_id}/auth/providers — list configured providers
DELETE /v1/projects/{project_id}/auth/providers/{name} — remove a provider

All require developer JWT. Credentials stored in Vault.
"""

from __future__ import annotations

import uuid
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project
from pqdb_api.services.vault import VaultClient, VaultError

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["oauth-providers"])

_SUPPORTED_PROVIDERS = frozenset({"google", "github"})


class ConfigureProviderRequest(BaseModel):
    """Request body for configuring an OAuth provider."""

    provider: str
    client_id: str
    client_secret: str


class ProviderListResponse(BaseModel):
    """Response body for listing configured providers."""

    providers: list[str]


async def _get_project_for_developer(
    project_id: uuid.UUID,
    developer_id: uuid.UUID,
    session: AsyncSession,
) -> Project:
    """Fetch a project, verifying it belongs to the developer."""
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


@router.post(
    "/{project_id}/auth/providers",
    status_code=201,
)
async def configure_provider(
    project_id: uuid.UUID,
    body: ConfigureProviderRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Configure an OAuth provider for a project.

    Stores client_id and client_secret in Vault. Only google and github
    are supported.
    """
    if body.provider not in _SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported provider: {body.provider}. "
            f"Supported: {', '.join(sorted(_SUPPORTED_PROVIDERS))}",
        )

    await _get_project_for_developer(project_id, developer_id, session)

    vault_client: VaultClient = request.app.state.vault_client
    credentials = {
        "client_id": body.client_id,
        "client_secret": body.client_secret,
    }
    try:
        vault_client.store_oauth_credentials(project_id, body.provider, credentials)
    except VaultError:
        raise HTTPException(
            status_code=500,
            detail="Failed to store OAuth credentials",
        )

    logger.info(
        "oauth_provider_configured",
        project_id=str(project_id),
        provider=body.provider,
    )

    return {"provider": body.provider, "status": "configured"}


@router.get(
    "/{project_id}/auth/providers",
    response_model=ProviderListResponse,
)
async def list_providers(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> ProviderListResponse:
    """List configured OAuth providers for a project.

    Returns provider names only, no secrets.
    """
    await _get_project_for_developer(project_id, developer_id, session)

    vault_client: VaultClient = request.app.state.vault_client
    providers = vault_client.list_oauth_providers(project_id)

    return ProviderListResponse(providers=providers)


@router.delete(
    "/{project_id}/auth/providers/{name}",
)
async def delete_provider(
    project_id: uuid.UUID,
    name: str,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Remove an OAuth provider configuration from a project.

    Deletes credentials from Vault.
    """
    await _get_project_for_developer(project_id, developer_id, session)

    vault_client: VaultClient = request.app.state.vault_client
    try:
        vault_client.delete_oauth_credentials(project_id, name)
    except VaultError:
        raise HTTPException(
            status_code=500,
            detail="Failed to delete OAuth credentials",
        )

    logger.info(
        "oauth_provider_deleted",
        project_id=str(project_id),
        provider=name,
    )

    return {"provider": name, "status": "deleted"}
