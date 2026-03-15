"""End-user authentication service.

Handles user signup, login, JWT creation with type:user_access,
refresh token hashing/verification, and password validation.
Reuses the same Ed25519 key pair as developer auth but uses
distinct JWT type fields (user_access / user_refresh).
"""

from __future__ import annotations

import dataclasses
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from pqdb_api.services.auth import JWT_ALGORITHM

ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7

_hasher = PasswordHasher()


@dataclasses.dataclass(frozen=True)
class UserTokenPair:
    """Access + refresh token pair for end-user auth."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserAuthService:
    """End-user authentication operations.

    Uses the same Ed25519 key pair as developer auth but produces
    JWTs with type=user_access and type=user_refresh to distinguish
    from developer tokens.
    """

    def __init__(
        self,
        private_key: Ed25519PrivateKey,
        public_key: Ed25519PublicKey,
    ) -> None:
        self._private_key = private_key
        self._public_key = public_key

    def create_user_access_token(
        self,
        *,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        role: str,
        email_verified: bool,
    ) -> str:
        """Create a short-lived JWT access token for an end-user."""
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(user_id),
            "project_id": str(project_id),
            "role": role,
            "type": "user_access",
            "email_verified": email_verified,
            "iat": now,
            "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        }
        return jwt.encode(payload, self._private_key, algorithm=JWT_ALGORITHM)

    def create_user_refresh_token(
        self,
        *,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
    ) -> str:
        """Create a long-lived JWT refresh token for an end-user."""
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(user_id),
            "project_id": str(project_id),
            "type": "user_refresh",
            "jti": str(uuid.uuid4()),
            "iat": now,
            "exp": now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        }
        return jwt.encode(payload, self._private_key, algorithm=JWT_ALGORITHM)

    def decode_user_token(
        self,
        token: str,
        *,
        expected_type: str,
    ) -> dict[str, Any]:
        """Decode and validate a user JWT token.

        Raises jwt.ExpiredSignatureError, jwt.PyJWTError, or ValueError.
        """
        payload: dict[str, Any] = jwt.decode(
            token, self._public_key, algorithms=[JWT_ALGORITHM]
        )
        if payload.get("type") != expected_type:
            raise ValueError(f"Invalid token type: expected {expected_type}")
        return payload

    def validate_password(self, password: str, *, min_length: int = 8) -> None:
        """Validate password meets minimum length requirement.

        Raises ValueError if password is too short.
        """
        if len(password) < min_length:
            raise ValueError(f"Password must be at least {min_length} characters")

    def hash_refresh_token(self, token: str) -> str:
        """Hash a refresh token for storage using argon2id."""
        return _hasher.hash(token)

    def verify_refresh_token(self, token_hash: str, token: str) -> bool:
        """Verify a refresh token against its stored hash."""
        try:
            return _hasher.verify(token_hash, token)
        except VerifyMismatchError:
            return False

    def create_token_pair(
        self,
        *,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        role: str,
        email_verified: bool,
    ) -> UserTokenPair:
        """Create both access and refresh tokens for an end-user."""
        access = self.create_user_access_token(
            user_id=user_id,
            project_id=project_id,
            role=role,
            email_verified=email_verified,
        )
        refresh = self.create_user_refresh_token(
            user_id=user_id,
            project_id=project_id,
        )
        return UserTokenPair(access_token=access, refresh_token=refresh)
