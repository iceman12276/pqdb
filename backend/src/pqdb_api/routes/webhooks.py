"""Database webhook configuration endpoints (US-110).

Routes under ``/v1/db/webhooks`` for creating, listing, and deleting
database webhook configurations. Webhooks fire on INSERT/UPDATE/DELETE
events via Postgres NOTIFY triggers.

All routes require a valid ``apikey`` header (service role).
"""

from __future__ import annotations

import secrets
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.db_webhook import (
    create_webhook_config,
    delete_webhook_config,
    install_trigger,
    list_webhook_configs,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/db", tags=["webhooks"])

_VALID_EVENTS = {"INSERT", "UPDATE", "DELETE"}


class CreateWebhookRequest(BaseModel):
    """Request body for POST /v1/db/webhooks."""

    table_name: str
    events: list[str]
    url: str
    secret: str | None = None

    @field_validator("events")
    @classmethod
    def validate_events(cls, v: list[str]) -> list[str]:
        if not v:
            msg = "At least one event is required"
            raise ValueError(msg)
        normalized = [e.upper() for e in v]
        for evt in normalized:
            if evt not in _VALID_EVENTS:
                msg = f"Invalid event: {evt!r}. Must be one of {sorted(_VALID_EVENTS)}"
                raise ValueError(msg)
        return normalized


@router.post("/webhooks", status_code=201)
async def create_webhook(
    body: CreateWebhookRequest,
    session: AsyncSession = Depends(get_project_session),
    context: ProjectContext = Depends(get_project_context),
) -> dict[str, Any]:
    """Create a webhook config and install a Postgres trigger.

    Only service-role API keys can create webhooks.
    If no secret is provided, a random 32-byte secret is generated.
    """
    if context.key_role != "service":
        raise HTTPException(
            status_code=403,
            detail="Only service_role API keys can manage webhooks",
        )

    webhook_secret = body.secret or secrets.token_urlsafe(32)

    try:
        config = await create_webhook_config(
            session,
            table_name=body.table_name,
            events=body.events,
            url=body.url,
            secret=webhook_secret,
        )
    except Exception as exc:
        logger.error("webhook_create_failed", error=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        await install_trigger(
            session,
            table_name=body.table_name,
            events=body.events,
        )
    except Exception as exc:
        logger.error("webhook_trigger_install_failed", error=str(exc))
        raise HTTPException(
            status_code=500,
            detail=f"Webhook created but trigger install failed: {exc}",
        ) from exc

    # Return the secret only on creation so the caller can store it
    config["secret"] = webhook_secret
    return config


@router.get("/webhooks")
async def list_webhooks(
    session: AsyncSession = Depends(get_project_session),
    context: ProjectContext = Depends(get_project_context),
) -> list[dict[str, Any]]:
    """List all configured webhooks for this project database.

    Only service-role API keys can list webhooks.
    Secrets are not returned in list responses.
    """
    if context.key_role != "service":
        raise HTTPException(
            status_code=403,
            detail="Only service_role API keys can manage webhooks",
        )

    return await list_webhook_configs(session)


@router.delete("/webhooks/{webhook_id}", status_code=204)
async def delete_webhook(
    webhook_id: int,
    session: AsyncSession = Depends(get_project_session),
    context: ProjectContext = Depends(get_project_context),
) -> None:
    """Delete a webhook config and drop the trigger if no webhooks remain.

    Only service-role API keys can delete webhooks.
    """
    if context.key_role != "service":
        raise HTTPException(
            status_code=403,
            detail="Only service_role API keys can manage webhooks",
        )

    deleted = await delete_webhook_config(session, webhook_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Webhook not found")
