"""Google OAuth flow endpoints — US-036.

GET /v1/auth/users/oauth/google/authorize — redirect to Google consent screen
GET /v1/auth/users/oauth/google/callback  — handle Google callback, issue tokens

Both endpoints require the apikey header for project resolution.
"""

from __future__ import annotations

import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import jwt
import structlog
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.auth import JWT_ALGORITHM
from pqdb_api.services.auth_engine import ensure_auth_tables
from pqdb_api.services.oauth import GoogleOAuthProvider
from pqdb_api.services.user_auth import UserAuthService
from pqdb_api.services.vault import VaultClient, VaultError

logger = structlog.get_logger()

router = APIRouter(
    prefix="/v1/auth/users/oauth/google",
    tags=["google-oauth"],
)

# nosemgrep: avoid-sqlalchemy-text
_SAFE = text

STATE_JWT_EXPIRY_MINUTES = 10


# ---------------------------------------------------------------------------
# State JWT helpers
# ---------------------------------------------------------------------------
def _generate_state_jwt(
    *,
    private_key: Ed25519PrivateKey,
    project_id: uuid.UUID,
    redirect_uri: str,
) -> str:
    """Generate a signed state JWT for CSRF protection.

    Contains redirect_uri, project_id, and a random nonce.
    Expires in 10 minutes.
    """
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "type": "oauth_state",
        "project_id": str(project_id),
        "redirect_uri": redirect_uri,
        "nonce": secrets.token_urlsafe(16),
        "iat": now,
        "exp": now + timedelta(minutes=STATE_JWT_EXPIRY_MINUTES),
    }
    return jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)


def _validate_state_jwt(
    *,
    public_key: Ed25519PublicKey,
    state: str,
) -> dict[str, Any]:
    """Validate and decode a state JWT.

    Raises ValueError if the token is invalid, expired, or has wrong type.
    """
    try:
        payload: dict[str, Any] = jwt.decode(
            state, public_key, algorithms=[JWT_ALGORITHM]
        )
    except (jwt.ExpiredSignatureError, jwt.PyJWTError):
        raise ValueError("State JWT is invalid or expired")

    if payload.get("type") != "oauth_state":
        raise ValueError("State JWT is invalid or expired")

    return payload


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/authorize")
async def google_authorize(
    redirect_uri: str,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
) -> RedirectResponse:
    """Initiate Google OAuth flow.

    Generates a state JWT and redirects to Google's consent screen.
    Returns 400 if Google OAuth is not configured for the project.
    """
    vault_client: VaultClient = request.app.state.vault_client

    try:
        credentials = vault_client.get_oauth_credentials(context.project_id, "google")
    except VaultError:
        raise HTTPException(
            status_code=400,
            detail="Google OAuth not configured for this project",
        )

    private_key: Ed25519PrivateKey = request.app.state.jwt_private_key
    state = _generate_state_jwt(
        private_key=private_key,
        project_id=context.project_id,
        redirect_uri=redirect_uri,
    )

    provider = GoogleOAuthProvider(
        client_id=credentials["client_id"],
        client_secret=credentials["client_secret"],
        http_client=getattr(request.app.state, "oauth_http_client", None),
    )

    # Build the callback URL for this request
    callback_url = str(request.url_for("google_callback"))
    authorization_url = provider.get_authorization_url(
        state=state, redirect_uri=callback_url
    )

    return RedirectResponse(url=authorization_url, status_code=302)


@router.get("/callback")
async def google_callback(
    code: str,
    state: str,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> RedirectResponse:
    """Handle Google OAuth callback.

    Validates state JWT, exchanges code for tokens, fetches user info,
    performs account linking (find-or-create), and redirects with tokens.
    """
    public_key: Ed25519PublicKey = request.app.state.jwt_public_key
    private_key: Ed25519PrivateKey = request.app.state.jwt_private_key

    # Validate state JWT
    try:
        state_payload = _validate_state_jwt(public_key=public_key, state=state)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired state parameter (CSRF protection)",
        )

    # Verify project_id in state matches the apikey project
    if state_payload.get("project_id") != str(context.project_id):
        raise HTTPException(
            status_code=400,
            detail="State project mismatch",
        )

    redirect_uri = state_payload["redirect_uri"]

    # Get OAuth credentials from Vault
    vault_client: VaultClient = request.app.state.vault_client
    try:
        credentials = vault_client.get_oauth_credentials(context.project_id, "google")
    except VaultError:
        raise HTTPException(
            status_code=400,
            detail="Google OAuth not configured for this project",
        )

    provider = GoogleOAuthProvider(
        client_id=credentials["client_id"],
        client_secret=credentials["client_secret"],
        http_client=getattr(request.app.state, "oauth_http_client", None),
    )

    # Exchange code for tokens
    callback_url = str(request.url_for("google_callback"))
    try:
        oauth_tokens = await provider.exchange_code(
            code=code, redirect_uri=callback_url
        )
    except ValueError as exc:
        logger.error("google_code_exchange_failed", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail="Failed to exchange authorization code",
        )

    # Fetch user info from Google
    try:
        user_info = await provider.get_user_info(oauth_tokens)
    except ValueError as exc:
        logger.error("google_userinfo_failed", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail="Failed to retrieve user info from Google",
        )

    # Ensure auth tables exist
    await ensure_auth_tables(session)

    # Account linking: find existing user by email
    result = await session.execute(
        _SAFE(
            "SELECT id, email, role, email_verified, metadata "
            "FROM _pqdb_users WHERE email = :email"
        ),
        {"email": user_info.email},
    )
    existing_user = result.fetchone()

    if existing_user is not None:
        # Link Google identity to existing user if email_verified
        user_id = uuid.UUID(str(existing_user[0]))
        email = existing_user[1]
        role = existing_user[2]
        email_verified = bool(existing_user[3])

        if not email_verified:
            # Update email_verified to true since Google verified the email
            await session.execute(
                _SAFE("UPDATE _pqdb_users SET email_verified = true WHERE id = :uid"),
                {"uid": str(user_id)},
            )
            email_verified = True

        # Check if OAuth identity already exists
        identity_result = await session.execute(
            _SAFE(
                "SELECT id FROM _pqdb_oauth_identities "
                "WHERE provider = 'google' AND provider_uid = :puid"
            ),
            {"puid": user_info.provider_uid},
        )
        if identity_result.fetchone() is None:
            # Create OAuth identity link
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
                    "VALUES (:id, :uid, 'google', :puid, :email, "
                    "CAST(:metadata AS jsonb))"
                ),
                {
                    "id": str(identity_id),
                    "uid": str(user_id),
                    "puid": user_info.provider_uid,
                    "email": user_info.email,
                    "metadata": metadata_json,
                },
            )

        logger.info(
            "google_oauth_linked",
            user_id=str(user_id),
            project_id=str(context.project_id),
        )
    else:
        # Create new user with email_verified = true, no password
        user_id = uuid.uuid4()
        email = user_info.email
        role = "authenticated"
        email_verified = True

        await session.execute(
            _SAFE(
                "INSERT INTO _pqdb_users "
                "(id, email, password_hash, role, email_verified) "
                "VALUES (:id, :email, NULL, 'authenticated', true)"
            ),
            {"id": str(user_id), "email": email},
        )

        # Create OAuth identity
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
                "VALUES (:id, :uid, 'google', :puid, :email, "
                "CAST(:metadata AS jsonb))"
            ),
            {
                "id": str(identity_id),
                "uid": str(user_id),
                "puid": user_info.provider_uid,
                "email": user_info.email,
                "metadata": metadata_json,
            },
        )

        logger.info(
            "google_oauth_user_created",
            user_id=str(user_id),
            project_id=str(context.project_id),
        )

    # Create user JWT tokens
    auth_service = UserAuthService(
        private_key=private_key,
        public_key=public_key,
    )
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

    # Redirect to the original redirect_uri with tokens as URL fragment params
    fragment = urlencode(
        {
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "token_type": "bearer",
        }
    )
    final_url = f"{redirect_uri}#{fragment}"

    return RedirectResponse(url=final_url, status_code=302)
