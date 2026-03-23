"""MFA/TOTP endpoints (US-039).

POST /v1/auth/users/mfa/enroll    — enroll TOTP factor + generate recovery codes
POST /v1/auth/users/mfa/verify    — verify TOTP code to activate MFA
POST /v1/auth/users/mfa/challenge — complete MFA challenge (TOTP or recovery code)
POST /v1/auth/users/mfa/unenroll  — disable MFA (requires valid TOTP code)

All endpoints use the apikey header for project resolution.
Enroll/verify/unenroll require user JWT (Authorization: Bearer).
Challenge requires mfa_ticket JWT.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.auth_engine import ensure_auth_tables
from pqdb_api.services.mfa import MFAService
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.user_auth import UserAuthService

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/auth/users/mfa", tags=["mfa"])

# Rate limit: 5 MFA challenge attempts per minute per ticket
_MFA_CHALLENGE_MAX_REQUESTS = 5
_MFA_CHALLENGE_WINDOW_SECONDS = 60

# nosemgrep: avoid-sqlalchemy-text
_SAFE = text


# ---------------------------------------------------------------------------
# Rate limiting (consolidated via RateLimiter)
# ---------------------------------------------------------------------------
def _check_mfa_rate_limit(
    request: Request,
    *,
    ticket: str,
) -> None:
    """Check MFA challenge rate limit (per ticket). Raises 429 if exceeded."""
    state = request.app.state
    attr_name = "_rate_limits_mfa_challenge"
    if not hasattr(state, attr_name):
        setattr(
            state,
            attr_name,
            RateLimiter(
                max_requests=_MFA_CHALLENGE_MAX_REQUESTS,
                window_seconds=_MFA_CHALLENGE_WINDOW_SECONDS,
            ),
        )

    limiter: RateLimiter = getattr(state, attr_name)
    if not limiter.is_allowed(ticket):
        raise HTTPException(
            status_code=429,
            detail={
                "error": {
                    "code": "rate_limited",
                    "message": "Too many requests. Try again later.",
                }
            },
        )


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class MFAVerifyRequest(BaseModel):
    """Request body for MFA verify."""

    code: str


class MFAChallengeRequest(BaseModel):
    """Request body for MFA challenge."""

    ticket: str
    code: str | None = None
    recovery_code: str | None = None


class MFAUnenrollRequest(BaseModel):
    """Request body for MFA unenroll."""

    code: str


class MFAEnrollResponse(BaseModel):
    """Response for MFA enrollment."""

    secret: str
    qr_uri: str
    recovery_codes: list[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_mfa_service(request: Request) -> MFAService:
    """Build an MFAService from app state keys."""
    private_key: bytes = request.app.state.mldsa65_private_key
    public_key: bytes = request.app.state.mldsa65_public_key
    return MFAService(private_key=private_key, public_key=public_key)


def _get_user_auth_service(request: Request) -> UserAuthService:
    """Build a UserAuthService from app state keys."""
    private_key: bytes = request.app.state.mldsa65_private_key
    public_key: bytes = request.app.state.mldsa65_public_key
    return UserAuthService(private_key=private_key, public_key=public_key)


async def _get_current_user_for_mfa(
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
        "project_id": str(context.project_id),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.post("/enroll", response_model=MFAEnrollResponse, status_code=200)
async def mfa_enroll(
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
    user: dict[str, Any] = Depends(_get_current_user_for_mfa),
) -> MFAEnrollResponse:
    """Enroll a TOTP factor for the current user.

    Generates TOTP secret, stores unverified factor,
    generates 10 recovery codes, returns all to client.
    Returns 409 if user already has a TOTP factor.
    """
    await ensure_auth_tables(session)
    user_id = user["id"]

    # Check if user already has a TOTP factor
    existing = await session.execute(
        _SAFE(
            "SELECT id FROM _pqdb_mfa_factors WHERE user_id = :uid AND type = 'totp'"
        ),
        {"uid": user_id},
    )
    if existing.fetchone() is not None:
        raise HTTPException(status_code=409, detail="TOTP factor already enrolled")

    mfa = _get_mfa_service(request)

    # Generate TOTP secret
    secret = mfa.generate_totp_secret()
    qr_uri = mfa.generate_qr_uri(secret=secret, email=user["email"])

    # Store unverified factor
    factor_id = uuid.uuid4()
    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_mfa_factors (id, user_id, type, secret, verified) "
            "VALUES (:id, :uid, 'totp', :secret, false)"
        ),
        {"id": str(factor_id), "uid": user_id, "secret": secret},
    )

    # Generate recovery codes
    recovery_codes = mfa.generate_recovery_codes()

    # Store hashed recovery codes
    for code in recovery_codes:
        code_id = uuid.uuid4()
        code_hash = mfa.hash_recovery_code(code)
        await session.execute(
            _SAFE(
                "INSERT INTO _pqdb_recovery_codes (id, user_id, code_hash) "
                "VALUES (:id, :uid, :hash)"
            ),
            {"id": str(code_id), "uid": user_id, "hash": code_hash},
        )

    await session.commit()

    logger.info("mfa_enrolled", user_id=user_id)

    return MFAEnrollResponse(
        secret=secret,
        qr_uri=qr_uri,
        recovery_codes=recovery_codes,
    )


@router.post("/verify", status_code=200)
async def mfa_verify(
    body: MFAVerifyRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
    user: dict[str, Any] = Depends(_get_current_user_for_mfa),
) -> dict[str, str]:
    """Verify a TOTP code and mark the factor as verified."""
    await ensure_auth_tables(session)
    user_id = user["id"]

    # Get unverified TOTP factor
    result = await session.execute(
        _SAFE(
            "SELECT id, secret, verified FROM _pqdb_mfa_factors "
            "WHERE user_id = :uid AND type = 'totp'"
        ),
        {"uid": user_id},
    )
    row = result.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No TOTP factor found")

    factor_id, secret, verified = str(row[0]), row[1], bool(row[2])

    if verified:
        raise HTTPException(status_code=400, detail="TOTP factor already verified")

    mfa = _get_mfa_service(request)
    if not mfa.verify_totp(secret, body.code):
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    # Mark as verified
    await session.execute(
        _SAFE("UPDATE _pqdb_mfa_factors SET verified = true WHERE id = :fid"),
        {"fid": factor_id},
    )
    await session.commit()

    logger.info("mfa_verified", user_id=user_id)
    return {"message": "MFA factor verified successfully"}


@router.post("/challenge", status_code=200)
async def mfa_challenge(
    body: MFAChallengeRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Complete an MFA challenge using TOTP code or recovery code.

    Validates the mfa_ticket JWT, then verifies the TOTP code or
    recovery code. On success, issues full user JWT (access + refresh).
    Rate limited: 5 attempts/min per ticket.
    """
    # Rate limit before any work
    _check_mfa_rate_limit(request, ticket=body.ticket)

    await ensure_auth_tables(session)

    if not body.code and not body.recovery_code:
        raise HTTPException(
            status_code=400, detail="Either code or recovery_code is required"
        )

    mfa = _get_mfa_service(request)

    # Decode MFA ticket
    try:
        ticket_payload = mfa.decode_mfa_ticket(body.ticket)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="MFA ticket expired")
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid MFA ticket")

    user_id = ticket_payload["sub"]
    ticket_project_id = ticket_payload.get("project_id")

    # Verify project matches
    if ticket_project_id != str(context.project_id):
        raise HTTPException(status_code=401, detail="Ticket does not match project")

    # Get verified TOTP factor
    result = await session.execute(
        _SAFE(
            "SELECT id, secret FROM _pqdb_mfa_factors "
            "WHERE user_id = :uid AND type = 'totp' AND verified = true"
        ),
        {"uid": user_id},
    )
    factor_row = result.fetchone()
    if factor_row is None:
        raise HTTPException(status_code=400, detail="No verified MFA factor found")

    secret = factor_row[1]

    if body.code:
        # Verify TOTP code
        if not mfa.verify_totp(secret, body.code):
            raise HTTPException(status_code=401, detail="Invalid TOTP code")
    elif body.recovery_code:
        # Verify recovery code
        codes_result = await session.execute(
            _SAFE(
                "SELECT id, code_hash FROM _pqdb_recovery_codes "
                "WHERE user_id = :uid AND used = false"
            ),
            {"uid": user_id},
        )
        code_rows = codes_result.fetchall()
        matched = False
        matched_code_id: str | None = None
        for code_row in code_rows:
            if mfa.verify_recovery_code(code_row[1], body.recovery_code):
                matched = True
                matched_code_id = str(code_row[0])
                break

        if not matched or matched_code_id is None:
            raise HTTPException(status_code=401, detail="Invalid recovery code")

        # Mark recovery code as used
        await session.execute(
            _SAFE("UPDATE _pqdb_recovery_codes SET used = true WHERE id = :cid"),
            {"cid": matched_code_id},
        )

    # Look up user to issue tokens
    user_result = await session.execute(
        _SAFE(
            "SELECT id, email, role, email_verified, metadata "
            "FROM _pqdb_users WHERE id = :uid"
        ),
        {"uid": user_id},
    )
    user_row = user_result.fetchone()
    if user_row is None:
        raise HTTPException(status_code=401, detail="User not found")

    user_auth = _get_user_auth_service(request)
    uid = uuid.UUID(str(user_row[0]))

    tokens = user_auth.create_token_pair(
        user_id=uid,
        project_id=context.project_id,
        role=user_row[2],
        email_verified=bool(user_row[3]),
    )

    # Store refresh token session
    refresh_hash = user_auth.hash_refresh_token(tokens.refresh_token)
    session_id = uuid.uuid4()
    expires_at = datetime.now(UTC) + timedelta(days=7)
    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_sessions (id, user_id, refresh_token_hash, expires_at) "
            "VALUES (:id, :user_id, :hash, :expires_at)"
        ),
        {
            "id": str(session_id),
            "user_id": str(uid),
            "hash": refresh_hash,
            "expires_at": expires_at,
        },
    )
    await session.commit()

    logger.info("mfa_challenge_passed", user_id=str(uid))

    return {
        "user": {
            "id": str(user_row[0]),
            "email": user_row[1],
            "role": user_row[2],
            "email_verified": bool(user_row[3]),
            "metadata": user_row[4] if isinstance(user_row[4], dict) else {},
        },
        "access_token": tokens.access_token,
        "refresh_token": tokens.refresh_token,
        "token_type": "bearer",
    }


@router.post("/unenroll", status_code=200)
async def mfa_unenroll(
    body: MFAUnenrollRequest,
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    session: AsyncSession = Depends(get_project_session),
    user: dict[str, Any] = Depends(_get_current_user_for_mfa),
) -> dict[str, str]:
    """Disable MFA for the current user.

    Requires a valid TOTP code to prove possession before disabling.
    Deletes MFA factor and all recovery codes.
    """
    await ensure_auth_tables(session)
    user_id = user["id"]

    # Get verified TOTP factor
    result = await session.execute(
        _SAFE(
            "SELECT id, secret FROM _pqdb_mfa_factors "
            "WHERE user_id = :uid AND type = 'totp' AND verified = true"
        ),
        {"uid": user_id},
    )
    row = result.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No verified MFA factor found")

    secret = row[1]
    mfa = _get_mfa_service(request)

    # Must prove possession with valid TOTP code
    if not mfa.verify_totp(secret, body.code):
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    # Delete MFA factor and recovery codes
    await session.execute(
        _SAFE("DELETE FROM _pqdb_recovery_codes WHERE user_id = :uid"),
        {"uid": user_id},
    )
    await session.execute(
        _SAFE("DELETE FROM _pqdb_mfa_factors WHERE user_id = :uid"),
        {"uid": user_id},
    )
    await session.commit()

    logger.info("mfa_unenrolled", user_id=user_id)
    return {"message": "MFA disabled successfully"}
