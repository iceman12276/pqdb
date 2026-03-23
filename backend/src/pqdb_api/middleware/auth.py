"""JWT authentication middleware (FastAPI dependency)."""

import uuid

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from pqdb_api.services.auth import InvalidTokenError, TokenExpiredError, decode_token

_bearer_scheme = HTTPBearer()


def _get_mldsa65_public_key(request: Request) -> bytes:
    """Extract ML-DSA-65 public key from app state."""
    key = getattr(request.app.state, "mldsa65_public_key", None)
    if not isinstance(key, bytes):
        raise HTTPException(status_code=500, detail="ML-DSA-65 public key not configured")
    return key


async def get_current_developer_id(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    request: Request = None,  # type: ignore[assignment]
) -> uuid.UUID:
    """Extract and validate ML-DSA-65 JWT from Authorization header.

    Returns the developer UUID from the token's ``sub`` claim.
    Raises 401 for missing, invalid, or expired tokens.
    """
    public_key = _get_mldsa65_public_key(request)
    try:
        payload = decode_token(credentials.credentials, public_key)
    except TokenExpiredError:
        raise HTTPException(status_code=401, detail="Token expired")
    except InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")

    sub = payload.get("sub")
    if sub is None:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        return uuid.UUID(sub)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid token")
