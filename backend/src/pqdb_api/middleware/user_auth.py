"""End-user JWT auth middleware (FastAPI dependency).

Validates user JWTs (type=user_access) from the Authorization: Bearer header
on project-scoped requests. Provides an optional UserContext alongside the
existing ProjectContext.
"""

from __future__ import annotations

import dataclasses
import uuid
from typing import Any

from fastapi import Depends, HTTPException, Request

from pqdb_api.middleware.api_key import ProjectContext, get_project_context
from pqdb_api.services.auth import InvalidTokenError, TokenExpiredError, decode_token


@dataclasses.dataclass(frozen=True)
class UserContext:
    """Immutable context resolved from a valid end-user JWT."""

    user_id: uuid.UUID
    project_id: uuid.UUID
    role: str
    email_verified: bool


def _get_mldsa65_public_key(request: Request) -> bytes:
    """Extract ML-DSA-65 public key from app state."""
    key = getattr(request.app.state, "mldsa65_public_key", None)
    if not isinstance(key, bytes):
        raise HTTPException(status_code=500, detail="ML-DSA-65 public key not configured")
    return key


def _validate_user_jwt(
    token: str,
    public_key: bytes,
    *,
    expected_project_id: uuid.UUID,
) -> UserContext | None:
    """Decode and validate a user JWT.

    Returns UserContext on success, None if the token is not a user token
    (e.g. a developer access token).
    Raises ValueError with a descriptive message on validation failure
    for tokens that ARE user tokens but are invalid/expired.
    """
    try:
        payload: dict[str, Any] = decode_token(token, public_key)
    except TokenExpiredError:
        raise ValueError("User token expired")
    except InvalidTokenError:
        raise ValueError("Invalid user token")

    # Not a user token (e.g. developer JWT with type=access) — ignore
    if payload.get("type") != "user_access":
        return None

    # Validate sub claim
    sub = payload.get("sub")
    if not sub:
        raise ValueError("Missing sub claim in user token")
    try:
        user_id = uuid.UUID(sub)
    except ValueError:
        raise ValueError(f"Invalid user_id in token: {sub}")

    # Validate project_id matches the API key's project
    token_project = payload.get("project_id")
    if token_project != str(expected_project_id):
        raise ValueError(
            f"Token project_id {token_project} does not match "
            f"API key project {expected_project_id}"
        )

    return UserContext(
        user_id=user_id,
        project_id=expected_project_id,
        role=payload.get("role", "authenticated"),
        email_verified=bool(payload.get("email_verified", False)),
    )


async def get_current_user(
    request: Request,
    context: ProjectContext = Depends(get_project_context),
) -> UserContext | None:
    """FastAPI dependency: optionally validate user JWT from Authorization header.

    Returns UserContext if a valid Bearer token is present.
    Returns None if no Authorization header is provided (allows
    unauthenticated/service-role access).
    Raises 401 with structured error for invalid/expired tokens.
    """
    auth_header = request.headers.get("authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None

    token = auth_header[7:]  # Strip "Bearer "
    public_key = _get_mldsa65_public_key(request)

    try:
        user_ctx = _validate_user_jwt(
            token, public_key, expected_project_id=context.project_id
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "user_token_invalid",
                    "message": str(exc),
                }
            },
        )

    return user_ctx
