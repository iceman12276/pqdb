"""Developer OAuth flow endpoints — US-052.

GET /v1/auth/oauth/{provider}/authorize — redirect to provider consent screen
GET /v1/auth/oauth/{provider}/callback  — handle provider callback, issue developer JWT

These endpoints authenticate *developers* (platform users), not end-users of
projects. Credentials are stored at the platform Vault path
secret/pqdb/platform/oauth/{provider}.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlparse

import jwt
import structlog
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.developer import Developer, DeveloperOAuthIdentity
from pqdb_api.services.auth import (
    JWT_ALGORITHM,
    create_access_token,
    create_refresh_token,
)
from pqdb_api.services.oauth import (
    GitHubOAuthProvider,
    GoogleOAuthProvider,
    OAuthProvider,
)
from pqdb_api.services.vault import VaultClient, VaultError

logger = structlog.get_logger()

router = APIRouter(
    prefix="/v1/auth/oauth",
    tags=["developer-oauth"],
)

STATE_JWT_EXPIRY_MINUTES = 10
SUPPORTED_PROVIDERS = ("google", "github")


# ---------------------------------------------------------------------------
# State JWT helpers
# ---------------------------------------------------------------------------
def _generate_dev_state_jwt(
    *,
    private_key: Ed25519PrivateKey,
    redirect_uri: str,
) -> str:
    """Generate a signed state JWT for developer OAuth CSRF protection.

    Contains redirect_uri and a random nonce. Expires in 10 minutes.
    Uses type 'dev_oauth_state' to distinguish from project-scoped OAuth.
    """
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "type": "dev_oauth_state",
        "redirect_uri": redirect_uri,
        "nonce": secrets.token_urlsafe(16),
        "iat": now,
        "exp": now + timedelta(minutes=STATE_JWT_EXPIRY_MINUTES),
    }
    return jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)


def _validate_dev_state_jwt(
    *,
    public_key: Ed25519PublicKey,
    state: str,
) -> dict[str, Any]:
    """Validate and decode a developer OAuth state JWT.

    Raises ValueError if the token is invalid, expired, or has wrong type.
    """
    try:
        payload: dict[str, Any] = jwt.decode(
            state, public_key, algorithms=[JWT_ALGORITHM]
        )
    except (jwt.ExpiredSignatureError, jwt.PyJWTError):
        raise ValueError("State JWT is invalid or expired")

    if payload.get("type") != "dev_oauth_state":
        raise ValueError("State JWT is invalid or expired")

    return payload


# ---------------------------------------------------------------------------
# Redirect URI validation
# ---------------------------------------------------------------------------
def _validate_redirect_uri(redirect_uri: str, allowed_origins: list[str]) -> None:
    """Validate redirect_uri against an allowlist of origins.

    Compares scheme + netloc (origin) of the redirect_uri against each
    allowed origin. Raises ValueError if no match is found.
    """
    parsed = urlparse(redirect_uri)
    request_origin = f"{parsed.scheme}://{parsed.netloc}"

    for allowed in allowed_origins:
        allowed_parsed = urlparse(allowed)
        allowed_origin = f"{allowed_parsed.scheme}://{allowed_parsed.netloc}"
        if request_origin == allowed_origin:
            return

    raise ValueError(f"Redirect URI origin {request_origin!r} not in allowed origins")


# ---------------------------------------------------------------------------
# Provider factory
# ---------------------------------------------------------------------------
def _make_provider(
    provider_name: str,
    client_id: str,
    client_secret: str,
    http_client: Any = None,
) -> OAuthProvider:
    """Create an OAuthProvider instance for the given provider name."""
    if provider_name == "google":
        return GoogleOAuthProvider(
            client_id=client_id,
            client_secret=client_secret,
            http_client=http_client,
        )
    if provider_name == "github":
        return GitHubOAuthProvider(
            client_id=client_id,
            client_secret=client_secret,
            http_client=http_client,
        )
    raise ValueError(f"Unsupported provider: {provider_name}")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/{provider}/authorize")
async def developer_oauth_authorize(
    provider: str,
    redirect_uri: str,
    request: Request,
) -> RedirectResponse:
    """Initiate developer OAuth flow.

    Generates a state JWT and redirects to provider's consent screen.
    Returns 400 if provider not supported or not configured.
    """
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported provider: {provider}")

    # Validate redirect_uri against allowlist to prevent open redirects
    settings = getattr(request.app.state, "settings", None)
    allowed_origins: list[str] = (
        settings.allowed_redirect_uris if settings else ["http://localhost:3000"]
    )
    try:
        _validate_redirect_uri(redirect_uri, allowed_origins)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="redirect_uri is not in the allowed origins",
        )

    vault_client: VaultClient = request.app.state.vault_client
    try:
        credentials = vault_client.get_platform_oauth_credentials(provider)
    except VaultError:
        raise HTTPException(
            status_code=400,
            detail=f"OAuth provider '{provider}' is not configured",
        )

    private_key: Ed25519PrivateKey = request.app.state.jwt_private_key
    state = _generate_dev_state_jwt(
        private_key=private_key,
        redirect_uri=redirect_uri,
    )

    http_client = getattr(request.app.state, "oauth_http_client", None)
    oauth_provider = _make_provider(
        provider,
        client_id=credentials["client_id"],
        client_secret=credentials["client_secret"],
        http_client=http_client,
    )

    callback_url = str(request.url_for("developer_oauth_callback", provider=provider))
    authorization_url = oauth_provider.get_authorization_url(
        state=state, redirect_uri=callback_url
    )

    return RedirectResponse(url=authorization_url, status_code=302)


@router.get("/{provider}/callback")
async def developer_oauth_callback(
    provider: str,
    code: str,
    state: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    """Handle developer OAuth callback.

    Validates state JWT, exchanges code for tokens, fetches user info,
    finds-or-creates developer, issues developer JWT pair.
    """
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported provider: {provider}")

    public_key: Ed25519PublicKey = request.app.state.jwt_public_key
    private_key: Ed25519PrivateKey = request.app.state.jwt_private_key

    # Validate state JWT
    try:
        state_payload = _validate_dev_state_jwt(public_key=public_key, state=state)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired state parameter",
        )

    redirect_uri = state_payload["redirect_uri"]

    # Get OAuth credentials from Vault
    vault_client: VaultClient = request.app.state.vault_client
    try:
        credentials = vault_client.get_platform_oauth_credentials(provider)
    except VaultError:
        raise HTTPException(
            status_code=400,
            detail=f"OAuth provider '{provider}' is not configured",
        )

    http_client = getattr(request.app.state, "oauth_http_client", None)
    oauth_provider = _make_provider(
        provider,
        client_id=credentials["client_id"],
        client_secret=credentials["client_secret"],
        http_client=http_client,
    )

    # Exchange code for tokens
    callback_url = str(request.url_for("developer_oauth_callback", provider=provider))
    try:
        oauth_tokens = await oauth_provider.exchange_code(
            code=code, redirect_uri=callback_url
        )
    except ValueError as exc:
        logger.error("developer_oauth_code_exchange_failed", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail="Failed to exchange authorization code",
        )

    # Fetch user info from provider
    try:
        user_info = await oauth_provider.get_user_info(oauth_tokens)
    except ValueError as exc:
        logger.error("developer_oauth_userinfo_failed", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail="Failed to retrieve user info from provider",
        )

    # Account linking: find existing developer by email
    result = await session.execute(
        select(Developer).where(Developer.email == user_info.email)
    )
    existing_dev = result.scalar_one_or_none()

    if existing_dev is not None:
        developer = existing_dev

        # Only link if existing developer has email_verified = true
        # OR set email_verified = true since provider verified the email
        if not developer.email_verified:
            developer.email_verified = True

        # Check if this OAuth identity already exists
        identity_result = await session.execute(
            select(DeveloperOAuthIdentity).where(
                DeveloperOAuthIdentity.provider == provider,
                DeveloperOAuthIdentity.provider_uid == user_info.provider_uid,
            )
        )
        if identity_result.scalar_one_or_none() is None:
            identity = DeveloperOAuthIdentity(
                id=uuid.uuid4(),
                developer_id=developer.id,
                provider=provider,
                provider_uid=user_info.provider_uid,
                email=user_info.email,
                metadata_={
                    "name": user_info.name,
                    "avatar_url": user_info.avatar_url,
                },
            )
            session.add(identity)

        logger.info(
            "developer_oauth_linked",
            developer_id=str(developer.id),
            provider=provider,
        )
    else:
        # Create new developer — OAuth login, no password
        developer = Developer(
            id=uuid.uuid4(),
            email=user_info.email,
            password_hash=None,
            email_verified=True,
        )
        session.add(developer)

        identity = DeveloperOAuthIdentity(
            id=uuid.uuid4(),
            developer_id=developer.id,
            provider=provider,
            provider_uid=user_info.provider_uid,
            email=user_info.email,
            metadata_={
                "name": user_info.name,
                "avatar_url": user_info.avatar_url,
            },
        )
        session.add(identity)

        logger.info(
            "developer_oauth_created",
            developer_id=str(developer.id),
            provider=provider,
        )

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Account linking conflict — email already in use",
        )

    # Issue developer JWT tokens
    access = create_access_token(developer.id, private_key)
    refresh = create_refresh_token(developer.id, private_key)

    # Redirect to the original redirect_uri with tokens as URL fragment params
    fragment = urlencode(
        {
            "access_token": access,
            "refresh_token": refresh,
            "token_type": "bearer",
        }
    )
    final_url = f"{redirect_uri}#{fragment}"

    return RedirectResponse(url=final_url, status_code=302)


# ---------------------------------------------------------------------------
# OAuth identity management (for settings page)
# ---------------------------------------------------------------------------
@router.get("/identities")
async def list_oauth_identities(
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """List OAuth identities linked to the current developer."""
    result = await session.execute(
        select(DeveloperOAuthIdentity).where(
            DeveloperOAuthIdentity.developer_id == developer_id
        )
    )
    identities = result.scalars().all()
    return [
        {
            "id": str(i.id),
            "provider": i.provider,
            "email": i.email,
            "created_at": i.created_at.isoformat(),
        }
        for i in identities
    ]


@router.delete("/identities/{identity_id}")
async def unlink_oauth_identity(
    identity_id: uuid.UUID,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Unlink an OAuth identity from the current developer."""
    result = await session.execute(
        select(DeveloperOAuthIdentity).where(
            DeveloperOAuthIdentity.id == identity_id,
            DeveloperOAuthIdentity.developer_id == developer_id,
        )
    )
    identity = result.scalar_one_or_none()
    if identity is None:
        raise HTTPException(status_code=404, detail="OAuth identity not found")

    await session.execute(
        delete(DeveloperOAuthIdentity).where(DeveloperOAuthIdentity.id == identity_id)
    )
    await session.commit()

    logger.info(
        "developer_oauth_unlinked",
        developer_id=str(developer_id),
        provider=identity.provider,
    )
    return {"status": "unlinked"}
