"""End-user authentication endpoints.

POST /v1/auth/users/signup          — register a new end-user
POST /v1/auth/users/login           — authenticate end-user
POST /v1/auth/users/logout          — revoke refresh token session
POST /v1/auth/users/refresh         — exchange refresh token for new access token
GET  /v1/auth/users/me              — get current user profile
PUT  /v1/auth/users/me              — update user metadata
POST /v1/auth/users/reset-password  — request a password reset (US-033)
POST /v1/auth/users/update-password — update password with reset token (US-033)

All endpoints use the apikey header for project resolution (same as /v1/db/*).
End-user JWTs have type=user_access to distinguish from developer tokens.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pydantic
import structlog
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.auth import hash_password, verify_password
from pqdb_api.services.auth_engine import ensure_auth_tables, get_auth_settings
from pqdb_api.services.mfa import MFAService
from pqdb_api.services.user_auth import UserAuthService
from pqdb_api.services.webhook import (
    WebhookDispatcher,
    generate_verification_token,
    hash_verification_token,
    verify_verification_token,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/auth/users", tags=["user-auth"])

# Rate limiter keys
_SIGNUP_LIMITER_PREFIX = "user_signup"
_LOGIN_LIMITER_PREFIX = "user_login"
_RESET_PASSWORD_LIMITER_PREFIX = "password_reset"

# nosemgrep: avoid-sqlalchemy-text
_SAFE = text


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class UserSignupRequest(BaseModel):
    """Request body for user signup."""

    email: EmailStr
    password: str = pydantic.Field(max_length=1024)


class UserLoginRequest(BaseModel):
    """Request body for user login."""

    email: EmailStr
    password: str = pydantic.Field(max_length=1024)


class UserLogoutRequest(BaseModel):
    """Request body for user logout."""

    refresh_token: str


class UserRefreshRequest(BaseModel):
    """Request body for user token refresh."""

    refresh_token: str


class UserProfile(BaseModel):
    """User profile response."""

    id: str
    email: str
    role: str
    email_verified: bool
    metadata: dict[str, Any]


class UserAuthResponse(BaseModel):
    """Signup/login response with user profile and tokens."""

    user: UserProfile
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class AccessTokenResponse(BaseModel):
    """Single access token response."""

    access_token: str
    token_type: str = "bearer"


class UserMetadataUpdate(BaseModel):
    """Request body for updating user metadata."""

    metadata: dict[str, Any]


class ResetPasswordRequest(BaseModel):
    """Request body for password reset request."""

    email: EmailStr


class UpdatePasswordRequest(BaseModel):
    """Request body for updating password with reset token."""

    token: str
    new_password: str = pydantic.Field(max_length=1024)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_user_auth_service(request: Request) -> UserAuthService:
    """Build a UserAuthService from app state keys."""
    private_key: Ed25519PrivateKey = request.app.state.jwt_private_key
    public_key: Ed25519PublicKey = request.app.state.jwt_public_key
    return UserAuthService(private_key=private_key, public_key=public_key)


def _get_client_ip(request: Request) -> str:
    """Extract client IP for rate limiting.

    Uses request.client.host only — does NOT trust X-Forwarded-For
    because it can be spoofed by clients to bypass rate limiting.
    """
    client = request.client
    if client:
        return client.host
    return "unknown"


def _check_rate_limit(
    request: Request,
    *,
    key_prefix: str,
    ip: str,
    max_requests: int,
    window_seconds: int = 60,
) -> None:
    """Check IP-based rate limit. Raises 429 if exceeded."""
    import time

    state = request.app.state
    attr_name = f"_rate_limits_{key_prefix}"
    if not hasattr(state, attr_name):
        setattr(state, attr_name, {})

    limits: dict[str, list[float]] = getattr(state, attr_name)
    now = time.monotonic()
    cutoff = now - window_seconds

    timestamps = limits.get(ip, [])
    timestamps = [t for t in timestamps if t > cutoff]

    if len(timestamps) >= max_requests:
        limits[ip] = timestamps
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    timestamps.append(now)
    limits[ip] = timestamps


async def _get_current_user(
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Extract and validate user JWT from Authorization header.

    Returns the user row as a dict. Raises 401 on invalid token.
    """
    auth_header = request.headers.get("authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization header")

    token = auth_header[7:]  # Strip "Bearer "
    service = _get_user_auth_service(request)

    try:
        payload = service.decode_user_token(token, expected_type="user_access")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Verify project_id matches the apikey project
    if payload.get("project_id") != str(context.project_id):
        raise HTTPException(status_code=401, detail="Token does not match project")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    # Look up user in project database
    await ensure_auth_tables(session)
    result = await session.execute(
        _SAFE(
            "SELECT id, email, role, email_verified, metadata "
            "FROM _pqdb_users WHERE id = :uid"
        ),
        {"uid": user_id},
    )
    row = result.fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="User not found")

    return {
        "id": str(row[0]),
        "email": row[1],
        "role": row[2],
        "email_verified": bool(row[3]),
        "metadata": row[4] if isinstance(row[4], dict) else {},
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.post("/signup", response_model=UserAuthResponse, status_code=201)
async def user_signup(
    body: UserSignupRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> UserAuthResponse:
    """Register a new end-user in the project database."""
    # Rate limiting: 10 signups/min per IP
    ip = _get_client_ip(request)
    _check_rate_limit(
        request, key_prefix=_SIGNUP_LIMITER_PREFIX, ip=ip, max_requests=10
    )

    await ensure_auth_tables(session)

    # Get password min length from auth settings
    settings = await get_auth_settings(session)
    min_length: int = settings.get("password_min_length", 8)

    service = _get_user_auth_service(request)

    try:
        service.validate_password(body.password, min_length=min_length)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Hash password and insert user
    pw_hash = hash_password(body.password)
    user_id = uuid.uuid4()

    # Check for duplicate email
    existing = await session.execute(
        _SAFE("SELECT id FROM _pqdb_users WHERE email = :email"),
        {"email": body.email},
    )
    if existing.fetchone() is not None:
        raise HTTPException(status_code=409, detail="Email already registered")

    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_users (id, email, password_hash, role) "
            "VALUES (:id, :email, :pw_hash, 'authenticated')"
        ),
        {"id": str(user_id), "email": body.email, "pw_hash": pw_hash},
    )

    # Create tokens
    tokens = service.create_token_pair(
        user_id=user_id,
        project_id=context.project_id,
        role="authenticated",
        email_verified=False,
    )

    # Store refresh token hash in _pqdb_sessions
    refresh_hash = service.hash_refresh_token(tokens.refresh_token)
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

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Email already registered")

    logger.info(
        "user_signup",
        user_id=str(user_id),
        project_id=str(context.project_id),
    )

    return UserAuthResponse(
        user=UserProfile(
            id=str(user_id),
            email=body.email,
            role="authenticated",
            email_verified=False,
            metadata={},
        ),
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
    )


@router.post("/login")
async def user_login(
    body: UserLoginRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> UserAuthResponse | dict[str, Any]:
    """Authenticate an end-user and return tokens.

    If the user has a verified MFA factor, returns
    { mfa_required: true, mfa_ticket: <jwt> } instead of tokens.
    """
    # Rate limiting: 20 logins/min per IP
    ip = _get_client_ip(request)
    _check_rate_limit(request, key_prefix=_LOGIN_LIMITER_PREFIX, ip=ip, max_requests=20)

    await ensure_auth_tables(session)

    # Look up user
    result = await session.execute(
        _SAFE(
            "SELECT id, email, password_hash, role, email_verified, metadata "
            "FROM _pqdb_users WHERE email = :email"
        ),
        {"email": body.email},
    )
    row = result.fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user_id_str, email, pw_hash, role, email_verified, metadata = (
        row[0],
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
    )

    if not verify_password(pw_hash, body.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user_id = uuid.UUID(str(user_id_str))

    # Check for verified MFA factor
    mfa_result = await session.execute(
        _SAFE(
            "SELECT id FROM _pqdb_mfa_factors "
            "WHERE user_id = :uid AND type = 'totp' AND verified = true"
        ),
        {"uid": str(user_id)},
    )
    has_mfa = mfa_result.fetchone() is not None

    if has_mfa:
        # Return MFA challenge instead of tokens
        mfa_service = MFAService(
            private_key=request.app.state.jwt_private_key,
            public_key=request.app.state.jwt_public_key,
        )
        mfa_ticket = mfa_service.create_mfa_ticket(
            user_id=user_id, project_id=context.project_id
        )
        logger.info(
            "user_login_mfa_required",
            user_id=str(user_id),
            project_id=str(context.project_id),
        )
        return {"mfa_required": True, "mfa_ticket": mfa_ticket}

    service = _get_user_auth_service(request)

    tokens = service.create_token_pair(
        user_id=user_id,
        project_id=context.project_id,
        role=role,
        email_verified=bool(email_verified),
    )

    # Store refresh token session
    refresh_hash = service.hash_refresh_token(tokens.refresh_token)
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
        "user_login",
        user_id=str(user_id),
        project_id=str(context.project_id),
    )

    return UserAuthResponse(
        user=UserProfile(
            id=str(user_id),
            email=email,
            role=role,
            email_verified=bool(email_verified),
            metadata=metadata if isinstance(metadata, dict) else {},
        ),
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
    )


@router.post("/logout", status_code=200)
async def user_logout(
    body: UserLogoutRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, str]:
    """Revoke a refresh token session."""
    await ensure_auth_tables(session)

    service = _get_user_auth_service(request)

    # Decode the refresh token to validate it
    try:
        payload = service.decode_user_token(
            body.refresh_token, expected_type="user_refresh"
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    # Verify project_id matches the apikey project
    if payload.get("project_id") != str(context.project_id):
        raise HTTPException(status_code=401, detail="Token does not match project")

    # Find and revoke matching session
    result = await session.execute(
        _SAFE(
            "SELECT id, refresh_token_hash FROM _pqdb_sessions "
            "WHERE user_id = :user_id AND revoked = false"
        ),
        {"user_id": payload["sub"]},
    )
    rows = result.fetchall()

    revoked = False
    for row in rows:
        session_id, token_hash = row[0], row[1]
        if service.verify_refresh_token(token_hash, body.refresh_token):
            await session.execute(
                _SAFE("UPDATE _pqdb_sessions SET revoked = true WHERE id = :id"),
                {"id": str(session_id)},
            )
            revoked = True
            break

    if not revoked:
        raise HTTPException(
            status_code=401, detail="Refresh token not found or already revoked"
        )

    await session.commit()

    logger.info(
        "user_logout",
        user_id=payload["sub"],
        project_id=str(context.project_id),
    )

    return {"message": "Logged out successfully"}


@router.post("/refresh", response_model=AccessTokenResponse)
async def user_refresh(
    body: UserRefreshRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> AccessTokenResponse:
    """Exchange a refresh token for a new access token."""
    await ensure_auth_tables(session)

    service = _get_user_auth_service(request)

    # Decode refresh token
    try:
        payload = service.decode_user_token(
            body.refresh_token, expected_type="user_refresh"
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Verify project_id matches the apikey project
    if payload.get("project_id") != str(context.project_id):
        raise HTTPException(status_code=401, detail="Token does not match project")

    user_id = payload["sub"]

    # Find matching non-revoked, non-expired session
    result = await session.execute(
        _SAFE(
            "SELECT id, refresh_token_hash, expires_at FROM _pqdb_sessions "
            "WHERE user_id = :user_id AND revoked = false"
        ),
        {"user_id": user_id},
    )
    rows = result.fetchall()

    matched = False
    for row in rows:
        _session_id, token_hash, expires_at = row[0], row[1], row[2]
        if service.verify_refresh_token(token_hash, body.refresh_token):
            # Check expiry
            if isinstance(expires_at, datetime):
                if expires_at.tzinfo is None:
                    # Treat naive datetime as UTC
                    if expires_at < datetime.now(UTC).replace(tzinfo=None):
                        raise HTTPException(
                            status_code=401, detail="Refresh token expired"
                        )
                elif expires_at < datetime.now(UTC):
                    raise HTTPException(status_code=401, detail="Refresh token expired")
            matched = True
            break

    if not matched:
        raise HTTPException(status_code=401, detail="Invalid or revoked refresh token")

    # Look up user to get current role and email_verified status
    user_result = await session.execute(
        _SAFE("SELECT role, email_verified FROM _pqdb_users WHERE id = :uid"),
        {"uid": user_id},
    )
    user_row = user_result.fetchone()
    if user_row is None:
        raise HTTPException(status_code=401, detail="User not found")

    role, email_verified = user_row[0], bool(user_row[1])

    access_token = service.create_user_access_token(
        user_id=uuid.UUID(user_id),
        project_id=context.project_id,
        role=role,
        email_verified=email_verified,
    )

    return AccessTokenResponse(access_token=access_token)


@router.get("/me", response_model=UserProfile)
async def get_user_profile(
    request: Request,
    user: dict[str, Any] = Depends(_get_current_user),
) -> UserProfile:
    """Get the current user's profile."""
    return UserProfile(**user)


@router.put("/me", response_model=UserProfile)
async def update_user_profile(
    body: UserMetadataUpdate,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
    user: dict[str, Any] = Depends(_get_current_user),
) -> UserProfile:
    """Update the current user's metadata."""
    import json

    user_id = user["id"]
    metadata_json = json.dumps(body.metadata)

    await session.execute(
        _SAFE(
            "UPDATE _pqdb_users SET metadata = CAST(:metadata AS jsonb), "
            "updated_at = now() WHERE id = :uid"
        ),
        {"metadata": metadata_json, "uid": user_id},
    )
    await session.commit()

    user["metadata"] = body.metadata
    return UserProfile(**user)


# ---------------------------------------------------------------------------
# Password reset endpoints (US-033)
# ---------------------------------------------------------------------------
_RESET_TOKEN_EXPIRY_SECONDS = 3600  # 1 hour


@router.post("/reset-password", status_code=200)
async def reset_password(
    body: ResetPasswordRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, str]:
    """Request a password reset token.

    Always returns 200 regardless of whether the email exists
    to prevent email enumeration attacks.
    Fires a webhook with type=password_reset if user exists
    and webhook URL is configured.
    """
    # Rate limiting: 5 reset requests/min per email
    _check_rate_limit(
        request,
        key_prefix=_RESET_PASSWORD_LIMITER_PREFIX,
        ip=body.email,
        max_requests=5,
        window_seconds=60,
    )

    await ensure_auth_tables(session)

    # Get webhook URL from auth settings
    settings = await get_auth_settings(session)
    webhook_url = settings.get("magic_link_webhook")

    if not webhook_url:
        raise HTTPException(
            status_code=400,
            detail="Webhook URL not configured",
        )

    # Look up user — if not found, return 200 (prevent enumeration)
    result = await session.execute(
        _SAFE("SELECT id FROM _pqdb_users WHERE email = :email"),
        {"email": body.email},
    )
    user_row = result.fetchone()

    if user_row is None:
        # User not found — return 200 silently
        return {"message": "If that email is registered, a reset link has been sent"}

    user_id = str(user_row[0])

    # Generate token and store hash
    token = generate_verification_token()
    token_hash = hash_verification_token(token)

    expires_at = datetime.now(UTC) + timedelta(seconds=_RESET_TOKEN_EXPIRY_SECONDS)
    token_id = uuid.uuid4()

    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_verification_tokens "
            "(id, user_id, email, token_hash, type, expires_at) "
            "VALUES (:id, :user_id, :email, :token_hash, 'password_reset', :expires_at)"
        ),
        {
            "id": str(token_id),
            "user_id": user_id,
            "email": body.email,
            "token_hash": token_hash,
            "expires_at": expires_at,
        },
    )
    await session.commit()

    # Fire webhook (fire-and-forget)
    dispatcher = WebhookDispatcher()
    await dispatcher.dispatch(
        url=webhook_url,
        event_type="password_reset",
        email=body.email,
        token=token,
        expires_in=_RESET_TOKEN_EXPIRY_SECONDS,
    )

    logger.info(
        "password_reset_requested",
        email=body.email,
        project_id=str(context.project_id),
    )

    return {"message": "If that email is registered, a reset link has been sent"}


@router.post("/update-password", status_code=200)
async def update_password(
    body: UpdatePasswordRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, str]:
    """Update password using a password reset token.

    Validates the token, updates the password hash, marks the
    token as used, and revokes ALL sessions for the user.
    """
    await ensure_auth_tables(session)

    # Find all unused, non-expired password_reset tokens
    result = await session.execute(
        _SAFE(
            "SELECT id, user_id, token_hash, expires_at "
            "FROM _pqdb_verification_tokens "
            "WHERE type = 'password_reset' AND used = false"
        ),
    )
    rows = result.fetchall()

    matched_token_id: str | None = None
    matched_user_id: str | None = None

    for row in rows:
        token_id, user_id, stored_hash, expires_at = (
            str(row[0]),
            str(row[1]),
            row[2],
            row[3],
        )

        # Check expiry
        if isinstance(expires_at, datetime):
            now = datetime.now(UTC)
            if expires_at.tzinfo is None:
                if expires_at < now.replace(tzinfo=None):
                    continue
            elif expires_at < now:
                continue

        # Verify token
        if verify_verification_token(stored_hash, body.token):
            matched_token_id = token_id
            matched_user_id = user_id
            break

    if matched_token_id is None or matched_user_id is None:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired reset token",
        )

    # Validate new password length
    settings = await get_auth_settings(session)
    min_length: int = settings.get("password_min_length", 8)
    service = _get_user_auth_service(request)

    try:
        service.validate_password(body.new_password, min_length=min_length)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Update password hash
    new_hash = hash_password(body.new_password)
    await session.execute(
        _SAFE(
            "UPDATE _pqdb_users SET password_hash = :pw_hash, "
            "updated_at = now() WHERE id = :uid"
        ),
        {"pw_hash": new_hash, "uid": matched_user_id},
    )

    # Mark token as used
    await session.execute(
        _SAFE("UPDATE _pqdb_verification_tokens SET used = true WHERE id = :id"),
        {"id": matched_token_id},
    )

    # Revoke ALL sessions for this user
    await session.execute(
        _SAFE("UPDATE _pqdb_sessions SET revoked = true WHERE user_id = :uid"),
        {"uid": matched_user_id},
    )

    await session.commit()

    logger.info(
        "password_updated",
        user_id=matched_user_id,
        project_id=str(context.project_id),
    )

    return {"message": "Password updated successfully"}


# ---------------------------------------------------------------------------
# Admin endpoint: assign role to user (requires service API key)
# ---------------------------------------------------------------------------
class UpdateUserRoleRequest(BaseModel):
    """Request body for updating a user's role."""

    role: str


@router.put("/{target_user_id}/role")
async def update_user_role(
    target_user_id: uuid.UUID,
    body: UpdateUserRoleRequest,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, str]:
    """Update a user's role. Requires service API key (admin-only).

    Validates that the role exists in _pqdb_roles before updating.
    """
    if context.key_role != "service":
        raise HTTPException(
            status_code=403,
            detail="Only service_role API keys can update user roles",
        )

    await ensure_auth_tables(session)

    # Validate role exists
    role_result = await session.execute(
        _SAFE("SELECT id FROM _pqdb_roles WHERE name = :name"),
        {"name": body.role},
    )
    if role_result.fetchone() is None:
        raise HTTPException(
            status_code=400,
            detail=f"Role {body.role!r} does not exist",
        )

    # Check user exists
    user_result = await session.execute(
        _SAFE("SELECT id FROM _pqdb_users WHERE id = :uid"),
        {"uid": str(target_user_id)},
    )
    if user_result.fetchone() is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Update role
    await session.execute(
        _SAFE("UPDATE _pqdb_users SET role = :role WHERE id = :uid"),
        {"role": body.role, "uid": str(target_user_id)},
    )
    await session.commit()

    logger.info(
        "user_role_updated",
        user_id=str(target_user_id),
        new_role=body.role,
    )

    return {"message": f"User role updated to {body.role!r}"}
