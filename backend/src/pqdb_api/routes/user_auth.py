"""End-user authentication endpoints.

POST /v1/auth/users/signup              — register a new end-user
POST /v1/auth/users/login               — authenticate end-user
POST /v1/auth/users/logout              — revoke refresh token session
POST /v1/auth/users/refresh             — exchange refresh token for new access token
POST /v1/auth/users/magic-link          — request a magic link (US-034)
POST /v1/auth/users/verify-magic-link   — verify a magic link token (US-034)
GET  /v1/auth/users/me                  — get current user profile
PUT  /v1/auth/users/me                  — update user metadata
POST /v1/auth/users/verify-email        — verify email with token (US-032)
POST /v1/auth/users/resend-verification — resend verification email (US-032)

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
from pqdb_api.services.email_verification import VERIFICATION_TOKEN_EXPIRY_SECONDS
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
_RESEND_VERIFICATION_PREFIX = "resend_verification"
_MAGIC_LINK_LIMITER_PREFIX = "magic_link"

# Magic link token expiry
_MAGIC_LINK_EXPIRY_SECONDS = 900  # 15 minutes

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


class VerifyEmailRequest(BaseModel):
    """Request body for POST /v1/auth/users/verify-email."""

    token: str


class ResendVerificationRequest(BaseModel):
    """Request body for POST /v1/auth/users/resend-verification."""

    email: EmailStr


class MagicLinkRequest(BaseModel):
    """Request body for magic link."""

    email: EmailStr


class VerifyMagicLinkRequest(BaseModel):
    """Request body for verifying a magic link token."""

    token: str


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


def _check_email_rate_limit(
    request: Request,
    *,
    key_prefix: str,
    email: str,
    max_requests: int,
    window_seconds: int = 60,
) -> None:
    """Check email-based rate limit. Raises 429 if exceeded."""
    import time

    state = request.app.state
    attr_name = f"_rate_limits_{key_prefix}_email"
    if not hasattr(state, attr_name):
        setattr(state, attr_name, {})

    limits: dict[str, list[float]] = getattr(state, attr_name)
    now = time.monotonic()
    cutoff = now - window_seconds

    timestamps = limits.get(email, [])
    timestamps = [t for t in timestamps if t > cutoff]

    if len(timestamps) >= max_requests:
        limits[email] = timestamps
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    timestamps.append(now)
    limits[email] = timestamps


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

    # Fire email verification webhook if magic_link_webhook is configured
    if settings.get("magic_link_webhook"):
        verification_token = generate_verification_token()
        token_hash = hash_verification_token(verification_token)
        token_id = uuid.uuid4()
        expires_at = datetime.now(UTC) + timedelta(
            seconds=VERIFICATION_TOKEN_EXPIRY_SECONDS
        )

        await session.execute(
            _SAFE(
                "INSERT INTO _pqdb_verification_tokens "
                "(id, user_id, email, token_hash, type, expires_at) "
                "VALUES (:id, :uid, :email, :hash, :type, :expires_at)"
            ),
            {
                "id": str(token_id),
                "uid": str(user_id),
                "email": body.email,
                "hash": token_hash,
                "type": "email_verification",
                "expires_at": expires_at,
            },
        )
        await session.commit()

        dispatcher = WebhookDispatcher()
        await dispatcher.dispatch(
            url=settings["magic_link_webhook"],
            event_type="email_verification",
            email=body.email,
            token=verification_token,
            expires_in=VERIFICATION_TOKEN_EXPIRY_SECONDS,
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

    # Users created via magic link have no password — reject login
    if pw_hash is None or not verify_password(pw_hash, body.password):
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
# Magic link endpoints (US-034)
# ---------------------------------------------------------------------------
@router.post("/magic-link")
async def request_magic_link(
    body: MagicLinkRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, str]:
    """Request a magic link for passwordless authentication.

    If the user exists, generates a token and fires a webhook.
    If the user does not exist, creates a new user with
    password_hash = NULL, then generates a token and fires a webhook.

    Returns 400 if magic_link_webhook is not configured.
    Rate limited to 5 requests/min per email.
    """
    await ensure_auth_tables(session)

    # Check magic_link_webhook is configured
    settings = await get_auth_settings(session)
    webhook_url = settings.get("magic_link_webhook")
    if not webhook_url:
        raise HTTPException(
            status_code=400,
            detail="Magic link webhook is not configured for this project",
        )

    # Rate limiting: 5 per minute per email
    _check_email_rate_limit(
        request,
        key_prefix=_MAGIC_LINK_LIMITER_PREFIX,
        email=body.email,
        max_requests=5,
    )

    # Look up or create user
    result = await session.execute(
        _SAFE("SELECT id, email FROM _pqdb_users WHERE email = :email"),
        {"email": body.email},
    )
    row = result.fetchone()

    if row is None:
        # Create new user with password_hash = NULL
        user_id = uuid.uuid4()
        await session.execute(
            _SAFE(
                "INSERT INTO _pqdb_users (id, email, role) "
                "VALUES (:id, :email, 'authenticated')"
            ),
            {"id": str(user_id), "email": body.email},
        )
    else:
        user_id = uuid.UUID(str(row[0]))

    # Generate token
    token = generate_verification_token()
    token_hash = hash_verification_token(token)
    token_id = uuid.uuid4()
    expires_at = datetime.now(UTC) + timedelta(seconds=_MAGIC_LINK_EXPIRY_SECONDS)

    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_verification_tokens "
            "(id, user_id, email, token_hash, type, expires_at) "
            "VALUES (:id, :user_id, :email, :token_hash, 'magic_link', :expires_at)"
        ),
        {
            "id": str(token_id),
            "user_id": str(user_id),
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
        event_type="magic_link",
        email=body.email,
        token=token,
        expires_in=_MAGIC_LINK_EXPIRY_SECONDS,
    )

    logger.info(
        "magic_link_requested",
        email=body.email,
        project_id=str(context.project_id),
    )

    return {"message": "Magic link sent"}


@router.post("/verify-magic-link")
async def verify_magic_link(
    body: VerifyMagicLinkRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> UserAuthResponse:
    """Verify a magic link token and return user + JWT tokens.

    Validates the token against _pqdb_verification_tokens,
    marks it as used (single-use), sets email_verified = true,
    creates a session, and returns { user, access_token, refresh_token }.
    """
    await ensure_auth_tables(session)

    # Find all unused, non-expired magic_link tokens
    result = await session.execute(
        _SAFE(
            "SELECT id, user_id, email, token_hash, expires_at "
            "FROM _pqdb_verification_tokens "
            "WHERE type = 'magic_link' AND used = false"
        ),
    )
    rows = result.fetchall()

    matched_row = None
    for row in rows:
        token_hash = row[3]
        if verify_verification_token(token_hash, body.token):
            matched_row = row
            break

    if matched_row is None:
        raise HTTPException(
            status_code=400, detail="Invalid or expired magic link token"
        )

    token_id, user_id_raw, email, _token_hash, expires_at = (
        matched_row[0],
        matched_row[1],
        matched_row[2],
        matched_row[3],
        matched_row[4],
    )

    # Check expiry
    if expires_at is not None:
        if isinstance(expires_at, datetime):
            exp = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
            if exp < datetime.now(UTC):
                raise HTTPException(
                    status_code=400, detail="Magic link token has expired"
                )

    # Mark token as used (single-use)
    await session.execute(
        _SAFE("UPDATE _pqdb_verification_tokens SET used = true WHERE id = :id"),
        {"id": str(token_id)},
    )

    # Set email_verified = true on the user
    user_id = uuid.UUID(str(user_id_raw))
    await session.execute(
        _SAFE(
            "UPDATE _pqdb_users SET email_verified = true, updated_at = now() "
            "WHERE id = :uid"
        ),
        {"uid": str(user_id)},
    )

    # Look up user details
    user_result = await session.execute(
        _SAFE(
            "SELECT id, email, role, email_verified, metadata "
            "FROM _pqdb_users WHERE id = :uid"
        ),
        {"uid": str(user_id)},
    )
    user_row = user_result.fetchone()
    if user_row is None:
        raise HTTPException(status_code=400, detail="User not found")

    role = user_row[2]
    metadata = user_row[4] if isinstance(user_row[4], dict) else {}

    # Create tokens
    service = _get_user_auth_service(request)
    tokens = service.create_token_pair(
        user_id=user_id,
        project_id=context.project_id,
        role=role,
        email_verified=True,
    )

    # Store refresh token session
    refresh_hash = service.hash_refresh_token(tokens.refresh_token)
    session_id = uuid.uuid4()
    session_expires_at = datetime.now(UTC) + timedelta(days=7)
    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_sessions (id, user_id, refresh_token_hash, expires_at) "
            "VALUES (:id, :user_id, :hash, :expires_at)"
        ),
        {
            "id": str(session_id),
            "user_id": str(user_id),
            "hash": refresh_hash,
            "expires_at": session_expires_at,
        },
    )
    await session.commit()

    logger.info(
        "magic_link_verified",
        user_id=str(user_id),
        email=email,
        project_id=str(context.project_id),
    )

    return UserAuthResponse(
        user=UserProfile(
            id=str(user_id),
            email=str(email),
            role=role,
            email_verified=True,
            metadata=metadata,
        ),
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
    )


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


# ---------------------------------------------------------------------------
# Email verification endpoints (US-032)
# ---------------------------------------------------------------------------
@router.post("/verify-email")
async def verify_email(
    body: VerifyEmailRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, str]:
    """Verify a user's email with a verification token.

    Validates the token against _pqdb_verification_tokens:
    - type must be 'email_verification'
    - token must not be expired
    - token must not be already used (single-use)

    On success, sets email_verified=true on the user.
    """
    await ensure_auth_tables(session)

    # Find all unused, non-expired email_verification tokens
    result = await session.execute(
        _SAFE(
            "SELECT id, user_id, token_hash, expires_at "
            "FROM _pqdb_verification_tokens "
            "WHERE type = 'email_verification' AND used = false"
        ),
    )
    rows = result.fetchall()

    matched_row = None
    for row in rows:
        token_id, user_id_val, token_hash, expires_at = row[0], row[1], row[2], row[3]
        if verify_verification_token(token_hash, body.token):
            matched_row = row
            break

    if matched_row is None:
        # Check if token was already used
        used_result = await session.execute(
            _SAFE(
                "SELECT id, token_hash "
                "FROM _pqdb_verification_tokens "
                "WHERE type = 'email_verification' AND used = true"
            ),
        )
        for used_row in used_result.fetchall():
            if verify_verification_token(used_row[1], body.token):
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "code": "token_already_used",
                            "message": "This verification token has already been used",
                        }
                    },
                )

        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "invalid_token",
                    "message": "Invalid verification token",
                }
            },
        )

    token_id = str(matched_row[0])
    user_id_val = str(matched_row[1])
    expires_at = matched_row[3]

    # Check expiry
    if expires_at is not None:
        if isinstance(expires_at, datetime):
            now = datetime.now(UTC)
            exp = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
            if exp < now:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "code": "token_expired",
                            "message": "Verification token has expired",
                        }
                    },
                )

    # Mark token as used
    await session.execute(
        _SAFE("UPDATE _pqdb_verification_tokens SET used = true WHERE id = :id"),
        {"id": token_id},
    )

    # Set email_verified = true on the user
    await session.execute(
        _SAFE(
            "UPDATE _pqdb_users SET email_verified = true, "
            "updated_at = now() WHERE id = :uid"
        ),
        {"uid": user_id_val},
    )
    await session.commit()

    logger.info(
        "email_verified",
        user_id=user_id_val,
        project_id=str(context.project_id),
    )

    return {"message": "Email verified successfully"}


@router.post("/resend-verification")
async def resend_verification(
    body: ResendVerificationRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, str]:
    """Resend a verification email to the user.

    Requires apikey header. Rate limited: 3 per minute per email.
    Generates a new verification token and fires the webhook.
    """
    # Rate limiting: 3/min per email
    _check_rate_limit(
        request,
        key_prefix=_RESEND_VERIFICATION_PREFIX,
        ip=body.email,  # Rate limit per email, not IP
        max_requests=3,
    )

    await ensure_auth_tables(session)

    # Check webhook is configured
    settings = await get_auth_settings(session)
    webhook_url = settings.get("magic_link_webhook")
    if not webhook_url:
        raise HTTPException(
            status_code=400,
            detail="Webhook URL not configured — cannot send verification email",
        )

    # Look up user
    result = await session.execute(
        _SAFE("SELECT id, email_verified FROM _pqdb_users WHERE email = :email"),
        {"email": body.email},
    )
    row = result.fetchone()
    if row is None:
        # Return success even if user not found to avoid email enumeration
        return {"message": "If the email is registered, a verification email was sent"}

    user_id = str(row[0])
    email_verified = bool(row[1])

    if email_verified:
        return {"message": "Email is already verified"}

    # Generate new token
    verification_token = generate_verification_token()
    token_hash = hash_verification_token(verification_token)
    token_id = uuid.uuid4()
    expires_at = datetime.now(UTC) + timedelta(
        seconds=VERIFICATION_TOKEN_EXPIRY_SECONDS
    )

    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_verification_tokens "
            "(id, user_id, email, token_hash, type, expires_at) "
            "VALUES (:id, :uid, :email, :hash, :type, :expires_at)"
        ),
        {
            "id": str(token_id),
            "uid": user_id,
            "email": body.email,
            "hash": token_hash,
            "type": "email_verification",
            "expires_at": expires_at,
        },
    )
    await session.commit()

    # Fire webhook
    dispatcher = WebhookDispatcher()
    await dispatcher.dispatch(
        url=webhook_url,
        event_type="email_verification",
        email=body.email,
        token=verification_token,
        expires_in=VERIFICATION_TOKEN_EXPIRY_SECONDS,
    )

    logger.info(
        "verification_resent",
        user_id=user_id,
        project_id=str(context.project_id),
    )

    return {"message": "If the email is registered, a verification email was sent"}
