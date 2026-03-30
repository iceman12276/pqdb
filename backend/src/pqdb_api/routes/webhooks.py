"""Database webhook configuration endpoints (US-110).

Routes under ``/v1/db/webhooks`` for creating, listing, and deleting
database webhook configurations. Webhooks fire on INSERT/UPDATE/DELETE
events via Postgres NOTIFY triggers.

All routes require a valid ``apikey`` header (service role).
"""

from __future__ import annotations

import ipaddress
import os
import secrets
from typing import Any
from urllib.parse import urlparse

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

# RFC 1918 + loopback + link-local networks that must be blocked
_BLOCKED_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _is_internal_ip(host: str) -> bool:
    """Check whether a hostname is an internal/blocked IP address."""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(addr in net for net in _BLOCKED_NETWORKS)


def validate_webhook_url(url: str) -> str:
    """Validate a webhook target URL against SSRF attacks.

    - Must be HTTPS (HTTP allowed only for localhost in dev/test)
    - Must not target RFC 1918, loopback, or link-local addresses
    """
    parsed = urlparse(url)

    if not parsed.hostname:
        msg = "URL must include a hostname"
        raise ValueError(msg)

    is_dev = os.environ.get("PQDB_DEBUG", "").lower() in ("1", "true")

    if parsed.scheme == "http":
        if not is_dev:
            msg = "Webhook URL must use HTTPS"
            raise ValueError(msg)
        # In dev mode, allow HTTP only for localhost
        if parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            msg = "HTTP webhooks are only allowed for localhost in dev mode"
            raise ValueError(msg)
    elif parsed.scheme != "https":
        msg = "Webhook URL must use HTTPS"
        raise ValueError(msg)

    # Block internal IPs even when scheme is valid
    if _is_internal_ip(parsed.hostname):
        msg = "Webhook URL must not target internal network addresses"
        raise ValueError(msg)

    return url


class CreateWebhookRequest(BaseModel):
    """Request body for POST /v1/db/webhooks."""

    table_name: str
    events: list[str]
    url: str
    secret: str | None = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        return validate_webhook_url(v)

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
