"""Authentication endpoints: signup, login, refresh."""

import base64
import binascii
import uuid

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.developer import Developer
from pqdb_api.services.auth import (
    InvalidTokenError,
    TokenExpiredError,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class AuthRequest(BaseModel):
    """Request body for login (email + password only)."""

    email: EmailStr
    password: str


class SignupRequest(BaseModel):
    """Request body for developer signup.

    Accepts an optional base64-encoded ML-KEM-768 public key. The server
    never generates this key — it is produced client-side by the SDK/
    Dashboard and uploaded at signup so project-creation calls can wrap
    per-project data to it.
    """

    email: EmailStr
    password: str
    ml_kem_public_key: str | None = None

    @field_validator("ml_kem_public_key")
    @classmethod
    def _validate_b64(cls, v: str | None) -> str | None:
        """Reject malformed base64 with a clear 422 error.

        Stores NULL only when the field is absent or explicitly null —
        never when the client sent garbage.
        """
        if v is None:
            return None
        try:
            # validate=True rejects characters outside the base64 alphabet.
            base64.b64decode(v, validate=True)
        except (binascii.Error, ValueError) as exc:
            msg = f"ml_kem_public_key must be valid base64: {exc}"
            raise ValueError(msg) from exc
        return v


class PublicKeyResponse(BaseModel):
    """Response body for GET /v1/auth/me/public-key."""

    public_key: str | None


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


def _get_private_key(request: Request) -> bytes:
    """Extract ML-DSA-65 private key from app state."""
    key: bytes = request.app.state.mldsa65_private_key
    return key


def _get_public_key(request: Request) -> bytes:
    """Extract ML-DSA-65 public key from app state."""
    key: bytes = request.app.state.mldsa65_public_key
    return key


@router.post("/signup", response_model=TokenResponse, status_code=201)
async def signup(
    body: SignupRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> TokenResponse:
    """Register a new developer account."""
    pw_hash = hash_password(body.password)
    # field_validator above already proved this is valid base64 (or None).
    pk_bytes: bytes | None = (
        base64.b64decode(body.ml_kem_public_key, validate=True)
        if body.ml_kem_public_key is not None
        else None
    )
    developer = Developer(
        id=uuid.uuid4(),
        email=body.email,
        password_hash=pw_hash,
        ml_kem_public_key=pk_bytes,
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
        payload = decode_token(body.refresh_token, public_key)
    except TokenExpiredError:
        raise HTTPException(status_code=401, detail="Refresh token expired")
    except InvalidTokenError:
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


@router.get("/me/public-key", response_model=PublicKeyResponse)
async def get_my_public_key(
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> PublicKeyResponse:
    """Return the authenticated developer's stored ML-KEM-768 public key.

    Returns ``{"public_key": null}`` when no key has been uploaded yet —
    never 404, so callers can distinguish "missing" from "endpoint gone".
    """
    result = await session.execute(
        select(Developer).where(Developer.id == developer_id)
    )
    developer = result.scalar_one_or_none()
    if developer is None:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    pk_b64: str | None = (
        base64.b64encode(developer.ml_kem_public_key).decode("ascii")
        if developer.ml_kem_public_key is not None
        else None
    )
    return PublicKeyResponse(public_key=pk_b64)


class ChangePasswordRequest(BaseModel):
    """Request body for changing password."""

    current_password: str
    new_password: str


@router.post("/change-password", response_model=TokenResponse)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> TokenResponse:
    """Change the developer's password and return new tokens.

    Verifies the current password, updates the hash, and issues
    a fresh token pair.
    """
    result = await session.execute(
        select(Developer).where(Developer.id == developer_id)
    )
    developer = result.scalar_one_or_none()
    if developer is None:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if developer.password_hash is None or not verify_password(
        developer.password_hash, body.current_password
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    developer.password_hash = hash_password(body.new_password)
    await session.commit()

    private_key = _get_private_key(request)
    access = create_access_token(developer_id, private_key)
    refresh = create_refresh_token(developer_id, private_key)
    logger.info("developer_password_changed", developer_id=str(developer_id))
    return TokenResponse(access_token=access, refresh_token=refresh)
