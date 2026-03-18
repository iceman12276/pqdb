"""Authentication endpoints: signup, login, refresh."""

import uuid

import jwt
import structlog
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.models.developer import Developer
from pqdb_api.services.auth import (
    JWT_ALGORITHM,
    create_access_token,
    create_refresh_token,
    hash_password,
    verify_password,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class AuthRequest(BaseModel):
    """Request body for signup and login."""

    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    """JWT token pair response."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    """Request body for token refresh."""

    refresh_token: str


class AccessTokenResponse(BaseModel):
    """Single access token response."""

    access_token: str
    token_type: str = "bearer"


def _get_private_key(request: Request) -> Ed25519PrivateKey:
    key: Ed25519PrivateKey = request.app.state.jwt_private_key
    return key


def _get_public_key(request: Request) -> Ed25519PublicKey:
    key: Ed25519PublicKey = request.app.state.jwt_public_key
    return key


@router.post("/signup", response_model=TokenResponse, status_code=201)
async def signup(
    body: AuthRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> TokenResponse:
    """Register a new developer account."""
    pw_hash = hash_password(body.password)
    developer = Developer(
        id=uuid.uuid4(),
        email=body.email,
        password_hash=pw_hash,
    )
    session.add(developer)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Email already registered")

    private_key = _get_private_key(request)
    access = create_access_token(developer.id, private_key)
    refresh = create_refresh_token(developer.id, private_key)
    logger.info("developer_signup", developer_id=str(developer.id))
    return TokenResponse(access_token=access, refresh_token=refresh)


@router.post("/login", response_model=TokenResponse)
async def login(
    body: AuthRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> TokenResponse:
    """Authenticate a developer and return JWT tokens."""
    result = await session.execute(
        select(Developer).where(Developer.email == body.email)
    )
    developer = result.scalar_one_or_none()
    if (
        developer is None
        or developer.password_hash is None
        or not verify_password(developer.password_hash, body.password)
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    private_key = _get_private_key(request)
    access = create_access_token(developer.id, private_key)
    refresh = create_refresh_token(developer.id, private_key)
    logger.info("developer_login", developer_id=str(developer.id))
    return TokenResponse(access_token=access, refresh_token=refresh)


@router.post("/refresh", response_model=AccessTokenResponse)
async def refresh(
    body: RefreshRequest,
    request: Request,
) -> AccessTokenResponse:
    """Exchange a refresh token for a new access token."""
    public_key = _get_public_key(request)
    private_key = _get_private_key(request)
    try:
        payload = jwt.decode(body.refresh_token, public_key, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Refresh token expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type")

    sub = payload.get("sub")
    if sub is None:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    try:
        developer_id = uuid.UUID(sub)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    access = create_access_token(developer_id, private_key)
    return AccessTokenResponse(access_token=access)
