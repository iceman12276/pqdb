"""Unit tests for end-user auth service.

Tests user signup, login, JWT creation with type:user_access,
session management, password validation, and token refresh.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pqdb_api.services.auth import (
    JWT_ALGORITHM,
    generate_ed25519_keypair,
    hash_password,
)
from pqdb_api.services.user_auth import (
    UserAuthService,
    UserTokenPair,
)


@pytest.fixture()
def ed25519_keys() -> tuple[Ed25519PrivateKey, Any]:
    private_key, public_key = generate_ed25519_keypair()
    return private_key, public_key


@pytest.fixture()
def user_auth_service(ed25519_keys: tuple[Any, Any]) -> UserAuthService:
    private_key, public_key = ed25519_keys
    return UserAuthService(
        private_key=private_key,
        public_key=public_key,
    )


class TestCreateUserAccessToken:
    """Test user access token creation."""

    def test_creates_valid_jwt(self, user_auth_service: UserAuthService, ed25519_keys: tuple[Any, Any]) -> None:
        _, public_key = ed25519_keys
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        token = user_auth_service.create_user_access_token(
            user_id=user_id,
            project_id=project_id,
            role="authenticated",
            email_verified=False,
        )
        payload = jwt.decode(token, public_key, algorithms=[JWT_ALGORITHM])
        assert payload["sub"] == str(user_id)
        assert payload["project_id"] == str(project_id)
        assert payload["role"] == "authenticated"
        assert payload["type"] == "user_access"
        assert payload["email_verified"] is False

    def test_access_token_expires_in_15_minutes(
        self, user_auth_service: UserAuthService, ed25519_keys: tuple[Any, Any]
    ) -> None:
        _, public_key = ed25519_keys
        token = user_auth_service.create_user_access_token(
            user_id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            role="authenticated",
            email_verified=False,
        )
        payload = jwt.decode(token, public_key, algorithms=[JWT_ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        iat = datetime.fromtimestamp(payload["iat"], tz=UTC)
        delta = exp - iat
        assert abs(delta.total_seconds() - 900) < 2  # 15 minutes = 900s


class TestCreateUserRefreshToken:
    """Test user refresh token creation."""

    def test_creates_valid_refresh_jwt(
        self, user_auth_service: UserAuthService, ed25519_keys: tuple[Any, Any]
    ) -> None:
        _, public_key = ed25519_keys
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        token = user_auth_service.create_user_refresh_token(
            user_id=user_id,
            project_id=project_id,
        )
        payload = jwt.decode(token, public_key, algorithms=[JWT_ALGORITHM])
        assert payload["sub"] == str(user_id)
        assert payload["project_id"] == str(project_id)
        assert payload["type"] == "user_refresh"

    def test_refresh_token_expires_in_7_days(
        self, user_auth_service: UserAuthService, ed25519_keys: tuple[Any, Any]
    ) -> None:
        _, public_key = ed25519_keys
        token = user_auth_service.create_user_refresh_token(
            user_id=uuid.uuid4(),
            project_id=uuid.uuid4(),
        )
        payload = jwt.decode(token, public_key, algorithms=[JWT_ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        iat = datetime.fromtimestamp(payload["iat"], tz=UTC)
        delta = exp - iat
        assert abs(delta.total_seconds() - 7 * 86400) < 2


class TestDecodeUserToken:
    """Test user token decoding."""

    def test_decode_valid_access_token(self, user_auth_service: UserAuthService) -> None:
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        token = user_auth_service.create_user_access_token(
            user_id=user_id,
            project_id=project_id,
            role="authenticated",
            email_verified=True,
        )
        payload = user_auth_service.decode_user_token(token, expected_type="user_access")
        assert payload["sub"] == str(user_id)
        assert payload["type"] == "user_access"

    def test_decode_wrong_type_raises(self, user_auth_service: UserAuthService) -> None:
        token = user_auth_service.create_user_access_token(
            user_id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            role="authenticated",
            email_verified=False,
        )
        with pytest.raises(ValueError, match="Invalid token type"):
            user_auth_service.decode_user_token(token, expected_type="user_refresh")

    def test_decode_expired_token_raises(self, ed25519_keys: tuple[Any, Any]) -> None:
        private_key, public_key = ed25519_keys
        service = UserAuthService(private_key=private_key, public_key=public_key)
        # Manually create an expired token
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "project_id": str(uuid.uuid4()),
            "type": "user_access",
            "role": "authenticated",
            "email_verified": False,
            "iat": now - timedelta(hours=1),
            "exp": now - timedelta(minutes=30),
        }
        token = jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)
        with pytest.raises(jwt.ExpiredSignatureError):
            service.decode_user_token(token, expected_type="user_access")

    def test_decode_invalid_token_raises(self, user_auth_service: UserAuthService) -> None:
        with pytest.raises(jwt.PyJWTError):
            user_auth_service.decode_user_token("invalid.token.here", expected_type="user_access")

    def test_decode_developer_token_rejected(self, ed25519_keys: tuple[Any, Any]) -> None:
        """Developer tokens (type=access) must be rejected by user auth."""
        private_key, public_key = ed25519_keys
        service = UserAuthService(private_key=private_key, public_key=public_key)
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "type": "access",  # developer token type
            "iat": now,
            "exp": now + timedelta(minutes=15),
        }
        token = jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)
        with pytest.raises(ValueError, match="Invalid token type"):
            service.decode_user_token(token, expected_type="user_access")


class TestPasswordValidation:
    """Test password length validation."""

    def test_password_too_short_raises(self, user_auth_service: UserAuthService) -> None:
        with pytest.raises(ValueError, match="at least 8 characters"):
            user_auth_service.validate_password("short", min_length=8)

    def test_password_exactly_min_length_passes(self, user_auth_service: UserAuthService) -> None:
        # Should not raise
        user_auth_service.validate_password("12345678", min_length=8)

    def test_password_exceeds_min_length_passes(self, user_auth_service: UserAuthService) -> None:
        user_auth_service.validate_password("a_very_long_password", min_length=8)

    def test_password_custom_min_length(self, user_auth_service: UserAuthService) -> None:
        with pytest.raises(ValueError, match="at least 12 characters"):
            user_auth_service.validate_password("short12345", min_length=12)


class TestHashAndStoreRefreshToken:
    """Test that refresh tokens are hashed for storage."""

    def test_hash_refresh_token_returns_argon2_hash(self, user_auth_service: UserAuthService) -> None:
        token = "some_jwt_token_string"
        hashed = user_auth_service.hash_refresh_token(token)
        assert hashed.startswith("$argon2id$")

    def test_verify_refresh_token_hash(self, user_auth_service: UserAuthService) -> None:
        token = "some_jwt_token_string"
        hashed = user_auth_service.hash_refresh_token(token)
        assert user_auth_service.verify_refresh_token(hashed, token) is True

    def test_verify_wrong_refresh_token(self, user_auth_service: UserAuthService) -> None:
        token = "correct_token"
        hashed = user_auth_service.hash_refresh_token(token)
        assert user_auth_service.verify_refresh_token(hashed, "wrong_token") is False


class TestCreateTokenPair:
    """Test creation of access + refresh token pairs."""

    def test_returns_token_pair(self, user_auth_service: UserAuthService) -> None:
        result = user_auth_service.create_token_pair(
            user_id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            role="authenticated",
            email_verified=False,
        )
        assert isinstance(result, UserTokenPair)
        assert result.access_token
        assert result.refresh_token
        assert result.token_type == "bearer"
