"""Unit tests for end-user auth middleware (US-026).

Tests JWT validation, project_id mismatch detection, optional
dependency behavior, and structured error responses.
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

from pqdb_api.middleware.user_auth import UserContext, _validate_user_jwt
from pqdb_api.services.auth import _build_mldsa65_token, generate_mldsa65_keypair

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)


@pytest.fixture()
def mldsa65_keys() -> tuple[bytes, bytes]:
    private_key, public_key = generate_mldsa65_keypair()
    return private_key, public_key


def _make_user_token(
    private_key: bytes,
    *,
    user_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    role: str = "authenticated",
    email_verified: bool = False,
    token_type: str = "user_access",
    expired: bool = False,
) -> str:
    """Helper to create a user JWT for testing."""
    now = datetime.now(UTC)
    iat = now - timedelta(minutes=5) if expired else now
    exp = now - timedelta(minutes=1) if expired else now + timedelta(minutes=15)
    payload: dict[str, Any] = {
        "sub": str(user_id or uuid.uuid4()),
        "project_id": str(project_id or uuid.uuid4()),
        "role": role,
        "type": token_type,
        "email_verified": email_verified,
        "iat": int(iat.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return _build_mldsa65_token(payload, private_key)


class TestValidateUserJwt:
    """Test the _validate_user_jwt helper."""

    def test_valid_token_returns_user_context(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        token = _make_user_token(
            private_key,
            user_id=user_id,
            project_id=project_id,
            role="authenticated",
            email_verified=True,
        )
        ctx = _validate_user_jwt(token, public_key, expected_project_id=project_id)
        assert isinstance(ctx, UserContext)
        assert ctx.user_id == user_id
        assert ctx.project_id == project_id
        assert ctx.role == "authenticated"
        assert ctx.email_verified is True

    def test_expired_token_raises_value_error(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        project_id = uuid.uuid4()
        token = _make_user_token(private_key, project_id=project_id, expired=True)
        with pytest.raises(ValueError, match="expired"):
            _validate_user_jwt(token, public_key, expected_project_id=project_id)

    def test_invalid_signature_raises_value_error(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        # Sign with a different key
        other_priv, _ = generate_mldsa65_keypair()
        _, public_key = mldsa65_keys
        project_id = uuid.uuid4()
        token = _make_user_token(other_priv, project_id=project_id)
        with pytest.raises(ValueError, match="Invalid user token"):
            _validate_user_jwt(token, public_key, expected_project_id=project_id)

    def test_wrong_token_type_returns_none(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        project_id = uuid.uuid4()
        # Developer access token (type=access, not user_access) — should
        # return None so the request proceeds without user context
        token = _make_user_token(
            private_key, project_id=project_id, token_type="access"
        )
        result = _validate_user_jwt(token, public_key, expected_project_id=project_id)
        assert result is None

    def test_project_id_mismatch_raises_value_error(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        token_project = uuid.uuid4()
        api_key_project = uuid.uuid4()
        token = _make_user_token(private_key, project_id=token_project)
        with pytest.raises(ValueError, match="project"):
            _validate_user_jwt(token, public_key, expected_project_id=api_key_project)

    def test_missing_sub_raises_value_error(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        project_id = uuid.uuid4()
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "project_id": str(project_id),
            "type": "user_access",
            "role": "authenticated",
            "email_verified": False,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=15)).timestamp()),
        }
        token = _build_mldsa65_token(payload, private_key)
        with pytest.raises(ValueError, match="Missing sub"):
            _validate_user_jwt(token, public_key, expected_project_id=project_id)

    def test_malformed_sub_raises_value_error(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        project_id = uuid.uuid4()
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": "not-a-uuid",
            "project_id": str(project_id),
            "type": "user_access",
            "role": "authenticated",
            "email_verified": False,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=15)).timestamp()),
        }
        token = _build_mldsa65_token(payload, private_key)
        with pytest.raises(ValueError, match="Invalid user_id"):
            _validate_user_jwt(token, public_key, expected_project_id=project_id)

    def test_garbage_token_raises_value_error(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        _, public_key = mldsa65_keys
        with pytest.raises(ValueError, match="Invalid user token"):
            _validate_user_jwt(
                "garbage.token.here",
                public_key,
                expected_project_id=uuid.uuid4(),
            )

    def test_refresh_token_type_returns_none(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        project_id = uuid.uuid4()
        token = _make_user_token(
            private_key, project_id=project_id, token_type="user_refresh"
        )
        result = _validate_user_jwt(token, public_key, expected_project_id=project_id)
        assert result is None


class TestUserContext:
    """Test UserContext dataclass."""

    def test_frozen_dataclass(self) -> None:
        ctx = UserContext(
            user_id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            role="authenticated",
            email_verified=False,
        )
        with pytest.raises(AttributeError):
            ctx.role = "admin"  # type: ignore[misc]

    def test_fields(self) -> None:
        uid = uuid.uuid4()
        pid = uuid.uuid4()
        ctx = UserContext(
            user_id=uid,
            project_id=pid,
            role="admin",
            email_verified=True,
        )
        assert ctx.user_id == uid
        assert ctx.project_id == pid
        assert ctx.role == "admin"
        assert ctx.email_verified is True
