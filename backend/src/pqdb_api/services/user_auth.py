"""End-user authentication service.

Handles user signup, login, JWT creation with type:user_access,
refresh token hashing/verification, and password validation.
Reuses the same ML-DSA-65 key pair as developer auth but uses
distinct JWT type fields (user_access / user_refresh).
"""

from __future__ import annotations

import dataclasses
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from pqdb_api.services.auth import _build_mldsa65_token, decode_token

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

    Uses the same ML-DSA-65 key pair as developer auth but produces
    JWTs with type=user_access and type=user_refresh to distinguish
    from developer tokens.
    """

    def __init__(
        self,
        private_key: bytes,
        public_key: bytes,
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
            "iat": int(now.timestamp()),
            "exp": int(
                (now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)).timestamp()
            ),
        }
        return _build_mldsa65_token(payload, self._private_key)

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
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)).timestamp()),
        }
        return _build_mldsa65_token(payload, self._private_key)

    def decode_user_token(
        self,
        token: str,
        *,
        expected_type: str,
    ) -> dict[str, Any]:
        """Decode and validate a user JWT token.

        Raises InvalidTokenError, TokenExpiredError, or ValueError.
        """
        payload: dict[str, Any] = decode_token(token, self._public_key)
        if payload.get("type") != expected_type:
            raise ValueError(f"Invalid token type: expected {expected_type}")
        return payload

    def validate_password(
        self, password: str, *, min_length: int = 8, max_length: int = 1024
    ) -> None:
        """Validate password meets length requirements.

        Raises ValueError if password is too short or too long.
        """
        if len(password) > max_length:
            raise ValueError(f"Password must not exceed {max_length} characters")
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
