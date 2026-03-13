"""JWT authentication middleware (FastAPI dependency)."""

import uuid

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from pqdb_api.services.auth import JWT_ALGORITHM

_bearer_scheme = HTTPBearer()


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


async def get_current_developer_id(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    request: Request = None,  # type: ignore[assignment]
) -> uuid.UUID:
    """Extract and validate JWT from Authorization header.

    Returns the developer UUID from the token's ``sub`` claim.
    Raises 401 for missing, invalid, or expired tokens.
    """
    public_key = _get_public_key(request)
    try:
        payload = jwt.decode(
            credentials.credentials, public_key, algorithms=[JWT_ALGORITHM]
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.PyJWTError:
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
