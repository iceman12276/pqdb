"""Unit tests for end-user auth service.

Tests user signup, login, JWT creation with type:user_access,
session management, password validation, and token refresh.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

try:
    import oqs  # noqa: F401

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    HAS_OQS = False

from pqdb_api.services.auth import (
    InvalidTokenError,
    TokenExpiredError,
    _build_mldsa65_token,
    decode_token,
    generate_mldsa65_keypair,
)
from pqdb_api.services.user_auth import (
    UserAuthService,
    UserTokenPair,
)

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)


@pytest.fixture()
def mldsa65_keys() -> tuple[bytes, bytes]:
    private_key, public_key = generate_mldsa65_keypair()
    return private_key, public_key


@pytest.fixture()
def user_auth_service(mldsa65_keys: tuple[bytes, bytes]) -> UserAuthService:
    private_key, public_key = mldsa65_keys
    return UserAuthService(
        private_key=private_key,
        public_key=public_key,
    )


class TestCreateUserAccessToken:
    """Test user access token creation."""

    def test_creates_valid_jwt(
        self, user_auth_service: UserAuthService, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        _, public_key = mldsa65_keys
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        token = user_auth_service.create_user_access_token(
            user_id=user_id,
            project_id=project_id,
            role="authenticated",
            email_verified=False,
        )
        payload = decode_token(token, public_key)
        assert payload["sub"] == str(user_id)
        assert payload["project_id"] == str(project_id)
        assert payload["role"] == "authenticated"
        assert payload["type"] == "user_access"
        assert payload["email_verified"] is False

    def test_access_token_expires_in_15_minutes(
        self, user_auth_service: UserAuthService, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        _, public_key = mldsa65_keys
        token = user_auth_service.create_user_access_token(
            user_id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            role="authenticated",
            email_verified=False,
        )
        payload = decode_token(token, public_key)
        exp = payload["exp"]
        iat = payload["iat"]
        assert abs(exp - iat - 900) < 2  # 15 minutes = 900s


class TestCreateUserRefreshToken:
    """Test user refresh token creation."""

    def test_creates_valid_refresh_jwt(
        self, user_auth_service: UserAuthService, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        _, public_key = mldsa65_keys
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        token = user_auth_service.create_user_refresh_token(
            user_id=user_id,
            project_id=project_id,
        )
        payload = decode_token(token, public_key)
        assert payload["sub"] == str(user_id)
        assert payload["project_id"] == str(project_id)
        assert payload["type"] == "user_refresh"

    def test_refresh_token_expires_in_7_days(
        self, user_auth_service: UserAuthService, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        _, public_key = mldsa65_keys
        token = user_auth_service.create_user_refresh_token(
            user_id=uuid.uuid4(),
            project_id=uuid.uuid4(),
        )
        payload = decode_token(token, public_key)
        exp = payload["exp"]
        iat = payload["iat"]
        assert abs(exp - iat - 7 * 86400) < 2


class TestDecodeUserToken:
    """Test user token decoding."""

    def test_decode_valid_access_token(
        self, user_auth_service: UserAuthService
    ) -> None:
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        token = user_auth_service.create_user_access_token(
            user_id=user_id,
            project_id=project_id,
            role="authenticated",
            email_verified=True,
        )
        payload = user_auth_service.decode_user_token(
            token, expected_type="user_access"
        )
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

    def test_decode_expired_token_raises(self, mldsa65_keys: tuple[bytes, bytes]) -> None:
        private_key, public_key = mldsa65_keys
        service = UserAuthService(private_key=private_key, public_key=public_key)
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "project_id": str(uuid.uuid4()),
            "type": "user_access",
            "role": "authenticated",
            "email_verified": False,
            "iat": int((now - timedelta(hours=1)).timestamp()),
            "exp": int((now - timedelta(minutes=30)).timestamp()),
        }
        token = _build_mldsa65_token(payload, private_key)
        with pytest.raises(TokenExpiredError):
            service.decode_user_token(token, expected_type="user_access")

    def test_decode_invalid_token_raises(
        self, user_auth_service: UserAuthService
    ) -> None:
        with pytest.raises(InvalidTokenError):
            user_auth_service.decode_user_token(
                "invalid.token.here", expected_type="user_access"
            )

    def test_decode_developer_token_rejected(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        """Developer tokens (type=access) must be rejected by user auth."""
        private_key, public_key = mldsa65_keys
        service = UserAuthService(private_key=private_key, public_key=public_key)
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "type": "access",  # developer token type
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=15)).timestamp()),
        }
        token = _build_mldsa65_token(payload, private_key)
        with pytest.raises(ValueError, match="Invalid token type"):
            service.decode_user_token(token, expected_type="user_access")


class TestPasswordValidation:
    """Test password length validation."""

    def test_password_too_short_raises(
        self, user_auth_service: UserAuthService
    ) -> None:
        with pytest.raises(ValueError, match="at least 8 characters"):
            user_auth_service.validate_password("short", min_length=8)

    def test_password_exactly_min_length_passes(
        self, user_auth_service: UserAuthService
    ) -> None:
        user_auth_service.validate_password("12345678", min_length=8)

    def test_password_exceeds_min_length_passes(
        self, user_auth_service: UserAuthService
    ) -> None:
        user_auth_service.validate_password("a_very_long_password", min_length=8)

    def test_password_custom_min_length(
        self, user_auth_service: UserAuthService
    ) -> None:
        with pytest.raises(ValueError, match="at least 12 characters"):
            user_auth_service.validate_password("short12345", min_length=12)

    def test_password_exceeds_max_length_raises(
        self, user_auth_service: UserAuthService
    ) -> None:
        long_password = "a" * 1025
        with pytest.raises(ValueError, match="must not exceed 1024 characters"):
            user_auth_service.validate_password(long_password, min_length=8)

    def test_password_at_max_length_passes(
        self, user_auth_service: UserAuthService
    ) -> None:
        password_1024 = "a" * 1024
        user_auth_service.validate_password(password_1024, min_length=8)


class TestHashAndStoreRefreshToken:
    """Test that refresh tokens are hashed for storage."""

    def test_hash_refresh_token_returns_argon2_hash(
        self, user_auth_service: UserAuthService
    ) -> None:
        token = "some_jwt_token_string"
        hashed = user_auth_service.hash_refresh_token(token)
        assert hashed.startswith("$argon2id$")

    def test_verify_refresh_token_hash(
        self, user_auth_service: UserAuthService
    ) -> None:
        token = "some_jwt_token_string"
        hashed = user_auth_service.hash_refresh_token(token)
        assert user_auth_service.verify_refresh_token(hashed, token) is True

    def test_verify_wrong_refresh_token(
        self, user_auth_service: UserAuthService
    ) -> None:
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
