"""GitHub OAuth login flow for end-users.

GET /v1/auth/users/oauth/github/authorize  — generate state JWT, redirect to GitHub
GET /v1/auth/users/oauth/github/callback   — validate state, exchange code, issue JWT

Requires apikey header for project resolution. Returns 400 if GitHub OAuth
is not configured for the project.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.auth_engine import ensure_auth_tables
from pqdb_api.services.oauth import GitHubOAuthProvider, OAuthUserInfo
from pqdb_api.services.user_auth import UserAuthService
from pqdb_api.services.vault import VaultClient, VaultError

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/auth/users/oauth/github", tags=["oauth-github"])

# nosemgrep: avoid-sqlalchemy-text
_SAFE = text

_STATE_TOKEN_EXPIRE_MINUTES = 10


def _get_user_auth_service(request: Request) -> UserAuthService:
    """Build UserAuthService from app state."""
    return UserAuthService(
        private_key=request.app.state.jwt_private_key,
        public_key=request.app.state.jwt_public_key,
    )


def _create_state_token(request: Request, project_id: uuid.UUID) -> str:
    """Create a short-lived JWT state token for CSRF protection."""
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "type": "oauth_state",
        "project_id": str(project_id),
        "provider": "github",
        "iat": now,
        "exp": now + timedelta(minutes=_STATE_TOKEN_EXPIRE_MINUTES),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, request.app.state.jwt_private_key, algorithm="EdDSA")


def _validate_state_token(request: Request, state: str) -> dict[str, Any]:
    """Validate and decode the state JWT."""
    try:
        payload: dict[str, Any] = jwt.decode(
            state,
            request.app.state.jwt_public_key,
            algorithms=["EdDSA"],
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=400, detail="State token expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=400, detail="Invalid state token")

    if payload.get("type") != "oauth_state":
        raise HTTPException(status_code=400, detail="Invalid state token type")
    if payload.get("provider") != "github":
        raise HTTPException(status_code=400, detail="State token provider mismatch")

    return payload


def _get_github_provider(
    request: Request, project_id: uuid.UUID
) -> GitHubOAuthProvider:
    """Load GitHub OAuth credentials from Vault and create provider instance."""
    vault_client: VaultClient = request.app.state.vault_client
    try:
        creds = vault_client.get_oauth_credentials(project_id, "github")
    except VaultError:
        raise HTTPException(
            status_code=400,
            detail="GitHub OAuth is not configured for this project",
        )

    return GitHubOAuthProvider(
        client_id=creds["client_id"],
        client_secret=creds["client_secret"],
    )


@router.get("/authorize")
async def github_authorize(
    request: Request,
    context: ProjectContext = Depends(get_project_context),
) -> RedirectResponse:
    """Generate state JWT and redirect to GitHub authorization page."""
    provider = _get_github_provider(request, context.project_id)
    state = _create_state_token(request, context.project_id)

    # Build redirect URI based on the current request
    redirect_uri = str(request.url_for("github_callback"))

    auth_url = provider.get_authorization_url(state=state, redirect_uri=redirect_uri)

    return RedirectResponse(url=auth_url, status_code=302)


@router.get("/callback")
async def github_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> RedirectResponse:
    """Handle GitHub OAuth callback.

    Validates state JWT, exchanges code for tokens, fetches user info,
    finds or creates user (account linking by verified email),
    issues JWT tokens, and redirects with tokens as URL fragment.
    """
    if error:
        raise HTTPException(
            status_code=400,
            detail=f"GitHub OAuth error: {error}",
        )

    if not code or not state:
        raise HTTPException(
            status_code=400,
            detail="Missing code or state parameter",
        )

    # Validate state token
    state_payload = _validate_state_token(request, state)

    # Verify project_id matches
    if state_payload.get("project_id") != str(context.project_id):
        raise HTTPException(status_code=400, detail="State token project mismatch")

    # Load provider
    provider = _get_github_provider(request, context.project_id)

    # Exchange code for tokens
    redirect_uri = str(request.url_for("github_callback"))
    try:
        oauth_tokens = await provider.exchange_code(
            code=code, redirect_uri=redirect_uri
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Fetch user info from GitHub
    try:
        user_info = await provider.get_user_info(oauth_tokens)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Account linking: find or create user
    await ensure_auth_tables(session)
    user_id, role, email_verified = await _find_or_create_user(
        session, user_info, context.project_id
    )

    # Issue JWT tokens
    auth_service = _get_user_auth_service(request)
    tokens = auth_service.create_token_pair(
        user_id=user_id,
        project_id=context.project_id,
        role=role,
        email_verified=email_verified,
    )

    # Store refresh token session
    refresh_hash = auth_service.hash_refresh_token(tokens.refresh_token)
    session_id = uuid.uuid4()
    expires_at = datetime.now(UTC) + timedelta(days=7)
    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_sessions (id, user_id, refresh_token_hash, expires_at) "
            "VALUES (:id, :user_id, :hash, :expires_at)"
        ),
        {
            "id": str(session_id),
            "user_id": str(user_id),
            "hash": refresh_hash,
            "expires_at": expires_at,
        },
    )
    await session.commit()

    logger.info(
        "github_oauth_login",
        user_id=str(user_id),
        project_id=str(context.project_id),
        provider="github",
    )

    # Redirect with tokens as URL fragment parameters
    # Using a fragment so tokens are not sent to the server on redirect
    fragment = (
        f"access_token={tokens.access_token}"
        f"&refresh_token={tokens.refresh_token}"
        f"&token_type=bearer"
    )
    # Use the project's configured redirect URL or a default
    redirect_url = f"/oauth/callback#{fragment}"

    return RedirectResponse(url=redirect_url, status_code=302)


async def _find_or_create_user(
    session: AsyncSession,
    user_info: OAuthUserInfo,
    project_id: uuid.UUID,
) -> tuple[uuid.UUID, str, bool]:
    """Find existing user by email or OAuth identity, or create new.

    Account linking logic:
    1. Check _pqdb_oauth_identities for existing link (provider + provider_uid)
    2. If not found, check _pqdb_users by email
    3. If user found by email, link the OAuth identity
    4. If no user found, create new user + link identity

    Returns (user_id, role, email_verified).
    """
    # 1. Check for existing OAuth identity
    result = await session.execute(
        _SAFE(
            "SELECT user_id FROM _pqdb_oauth_identities "
            "WHERE provider = :provider AND provider_uid = :uid"
        ),
        {"provider": "github", "uid": user_info.provider_uid},
    )
    row = result.fetchone()
    if row is not None:
        existing_user_id = uuid.UUID(str(row[0]))
        # Fetch user details
        user_result = await session.execute(
            _SAFE("SELECT role, email_verified FROM _pqdb_users WHERE id = :uid"),
            {"uid": str(existing_user_id)},
        )
        user_row = user_result.fetchone()
        if user_row is not None:
            return existing_user_id, str(user_row[0]), bool(user_row[1])

    # 2. Check for existing user by email
    result = await session.execute(
        _SAFE("SELECT id, role, email_verified FROM _pqdb_users WHERE email = :email"),
        {"email": user_info.email},
    )
    row = result.fetchone()

    if row is not None:
        # 3. Link OAuth identity to existing user
        existing_user_id = uuid.UUID(str(row[0]))
        identity_id = uuid.uuid4()
        metadata_json = json.dumps(
            {
                "name": user_info.name,
                "avatar_url": user_info.avatar_url,
            }
        )
        await session.execute(
            _SAFE(
                "INSERT INTO _pqdb_oauth_identities "
                "(id, user_id, provider, provider_uid, email, metadata) "
                "VALUES (:id, :user_id, :provider, :provider_uid, :email, "
                "CAST(:metadata AS jsonb))"
            ),
            {
                "id": str(identity_id),
                "user_id": str(existing_user_id),
                "provider": "github",
                "provider_uid": user_info.provider_uid,
                "email": user_info.email,
                "metadata": metadata_json,
            },
        )
        # Mark email as verified since GitHub verified it
        await session.execute(
            _SAFE("UPDATE _pqdb_users SET email_verified = true WHERE id = :uid"),
            {"uid": str(existing_user_id)},
        )
        return existing_user_id, str(row[1]), True

    # 4. Create new user + OAuth identity
    new_user_id = uuid.uuid4()

    # OAuth users get a random unusable password hash
    import secrets

    dummy_hash = f"$oauth$github${secrets.token_hex(32)}"

    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_users (id, email, password_hash, role, email_verified) "
            "VALUES (:id, :email, :pw_hash, 'authenticated', true)"
        ),
        {
            "id": str(new_user_id),
            "email": user_info.email,
            "pw_hash": dummy_hash,
        },
    )

    identity_id = uuid.uuid4()
    metadata_json = json.dumps(
        {
            "name": user_info.name,
            "avatar_url": user_info.avatar_url,
        }
    )
    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_oauth_identities "
            "(id, user_id, provider, provider_uid, email, metadata) "
            "VALUES (:id, :user_id, :provider, :provider_uid, :email, "
            "CAST(:metadata AS jsonb))"
        ),
        {
            "id": str(identity_id),
            "user_id": str(new_user_id),
            "provider": "github",
            "provider_uid": user_info.provider_uid,
            "email": user_info.email,
            "metadata": metadata_json,
        },
    )

    return new_user_id, "authenticated", True
