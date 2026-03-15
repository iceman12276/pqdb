"""End-user JWT auth middleware (FastAPI dependency).

Validates user JWTs (type=user_access) from the Authorization: Bearer header
on project-scoped requests. Provides an optional UserContext alongside the
existing ProjectContext.
"""

from __future__ import annotations

import dataclasses
import uuid
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from fastapi import Depends, HTTPException, Request

from pqdb_api.middleware.api_key import ProjectContext, get_project_context
from pqdb_api.services.auth import JWT_ALGORITHM


@dataclasses.dataclass(frozen=True)
class UserContext:
    """Immutable context resolved from a valid end-user JWT."""

    user_id: uuid.UUID
    project_id: uuid.UUID
    role: str
    email_verified: bool


def _get_public_key(request: Request) -> Ed25519PublicKey:
    """Extract Ed25519 public key from app state."""
    key = request.app.state.jwt_public_key
    if isinstance(key, Ed25519PublicKey):
        return key
    if isinstance(key, (str, bytes)):
        pem = key.encode() if isinstance(key, str) else key
        loaded = load_pem_public_key(pem)
        if not isinstance(loaded, Ed25519PublicKey):
            raise HTTPException(status_code=500, detail="Invalid JWT key type")
        return loaded
    raise HTTPException(status_code=500, detail="JWT public key not configured")


def _validate_user_jwt(
    token: str,
    public_key: Ed25519PublicKey,
    *,
    expected_project_id: uuid.UUID,
) -> UserContext:
    """Decode and validate a user JWT.

    Returns UserContext on success.
    Raises ValueError with a descriptive message on any validation failure.
    """
    try:
        payload: dict[str, Any] = jwt.decode(
            token, public_key, algorithms=[JWT_ALGORITHM]
        )
    except jwt.ExpiredSignatureError:
        raise ValueError("User token expired")
    except jwt.PyJWTError:
        raise ValueError("Invalid user token")

    # Must be a user_access token
    if payload.get("type") != "user_access":
        raise ValueError(
            f"Invalid token type: expected user_access, got {payload.get('type')}"
        )

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
    public_key = _get_public_key(request)

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
