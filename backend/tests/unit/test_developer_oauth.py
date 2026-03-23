"""Unit tests for developer OAuth route logic — US-052.

Tests state JWT generation/validation, account linking logic,
and error handling. Does not need Postgres (pure logic tests).
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

try:
    import oqs  # noqa: F401

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    HAS_OQS = False

from pqdb_api.services.auth import _build_mldsa65_token, decode_token, generate_mldsa65_keypair


@pytest.fixture()
def keypair() -> tuple[bytes, bytes]:
    if not HAS_OQS:
        pytest.skip("liboqs not available")
    return generate_mldsa65_keypair()


class TestStateJwtGeneration:
    """Test state JWT generation for developer OAuth."""

    @pytest.mark.skipif(not HAS_OQS, reason="liboqs not available")
    def test_generate_state_jwt_contains_required_fields(
        self,
        keypair: tuple[bytes, bytes],
    ) -> None:
        from pqdb_api.routes.developer_oauth import _generate_dev_state_jwt

        private_key, public_key = keypair
        redirect_uri = "https://dashboard.pqdb.io/auth/callback"
        state = _generate_dev_state_jwt(
            private_key=private_key,
            redirect_uri=redirect_uri,
        )

        payload = decode_token(state, public_key)
        assert payload["type"] == "dev_oauth_state"
        assert payload["redirect_uri"] == redirect_uri
        assert "nonce" in payload
        assert "exp" in payload
        assert "iat" in payload

    @pytest.mark.skipif(not HAS_OQS, reason="liboqs not available")
    def test_state_jwt_expires_in_10_minutes(
        self,
        keypair: tuple[bytes, bytes],
    ) -> None:
        from pqdb_api.routes.developer_oauth import _generate_dev_state_jwt

        private_key, public_key = keypair
        state = _generate_dev_state_jwt(
            private_key=private_key,
            redirect_uri="https://example.com/cb",
        )
        payload = decode_token(state, public_key)
        exp = payload["exp"]
        iat = payload["iat"]
        delta = exp - iat
        assert 9 * 60 < delta <= 10 * 60 + 5


class TestStateJwtValidation:
    """Test state JWT validation for developer OAuth."""

    @pytest.mark.skipif(not HAS_OQS, reason="liboqs not available")
    def test_validates_good_state(
        self,
        keypair: tuple[bytes, bytes],
    ) -> None:
        from pqdb_api.routes.developer_oauth import (
            _generate_dev_state_jwt,
            _validate_dev_state_jwt,
        )

        private_key, public_key = keypair
        state = _generate_dev_state_jwt(
            private_key=private_key,
            redirect_uri="https://example.com/cb",
        )
        payload = _validate_dev_state_jwt(public_key=public_key, state=state)
        assert payload["type"] == "dev_oauth_state"
        assert payload["redirect_uri"] == "https://example.com/cb"

    @pytest.mark.skipif(not HAS_OQS, reason="liboqs not available")
    def test_rejects_expired_state(
        self,
        keypair: tuple[bytes, bytes],
    ) -> None:
        from pqdb_api.routes.developer_oauth import _validate_dev_state_jwt

        private_key, public_key = keypair
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "type": "dev_oauth_state",
            "redirect_uri": "https://example.com/cb",
            "nonce": secrets.token_urlsafe(16),
            "iat": int((now - timedelta(minutes=20)).timestamp()),
            "exp": int((now - timedelta(minutes=10)).timestamp()),
        }
        state = _build_mldsa65_token(payload, private_key)
        with pytest.raises(ValueError, match="invalid or expired"):
            _validate_dev_state_jwt(public_key=public_key, state=state)

    @pytest.mark.skipif(not HAS_OQS, reason="liboqs not available")
    def test_rejects_wrong_type(
        self,
        keypair: tuple[bytes, bytes],
    ) -> None:
        from pqdb_api.routes.developer_oauth import _validate_dev_state_jwt

        private_key, public_key = keypair
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "type": "oauth_state",  # wrong type — not dev_oauth_state
            "redirect_uri": "https://example.com/cb",
            "nonce": secrets.token_urlsafe(16),
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=10)).timestamp()),
        }
        state = _build_mldsa65_token(payload, private_key)
        with pytest.raises(ValueError, match="invalid or expired"):
            _validate_dev_state_jwt(public_key=public_key, state=state)

    @pytest.mark.skipif(not HAS_OQS, reason="liboqs not available")
    def test_rejects_garbage_token(
        self,
        keypair: tuple[bytes, bytes],
    ) -> None:
        from pqdb_api.routes.developer_oauth import _validate_dev_state_jwt

        _, public_key = keypair
        with pytest.raises(ValueError, match="invalid or expired"):
            _validate_dev_state_jwt(public_key=public_key, state="not-a-jwt")

    @pytest.mark.skipif(not HAS_OQS, reason="liboqs not available")
    def test_rejects_token_signed_with_different_key(
        self,
        keypair: tuple[bytes, bytes],
    ) -> None:
        from pqdb_api.routes.developer_oauth import _validate_dev_state_jwt

        _, public_key = keypair
        other_private, _ = generate_mldsa65_keypair()
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "type": "dev_oauth_state",
            "redirect_uri": "https://example.com/cb",
            "nonce": secrets.token_urlsafe(16),
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=10)).timestamp()),
        }
        state = _build_mldsa65_token(payload, other_private)
        with pytest.raises(ValueError, match="invalid or expired"):
            _validate_dev_state_jwt(public_key=public_key, state=state)


class TestDeveloperOAuthModel:
    """Test DeveloperOAuthIdentity model exists with correct schema."""

    def test_developer_model_has_email_verified(self) -> None:
        from pqdb_api.models.developer import Developer

        dev = Developer(
            id=uuid.uuid4(),
            email="dev@test.com",
            password_hash=None,
            email_verified=True,
        )
        assert dev.email_verified is True

    def test_developer_allows_null_password_hash(self) -> None:
        from pqdb_api.models.developer import Developer

        dev = Developer(
            id=uuid.uuid4(),
            email="dev@test.com",
            password_hash=None,
        )
        assert dev.password_hash is None

    def test_developer_oauth_identity_model_exists(self) -> None:
        from pqdb_api.models.developer import DeveloperOAuthIdentity

        identity = DeveloperOAuthIdentity(
            id=uuid.uuid4(),
            developer_id=uuid.uuid4(),
            provider="google",
            provider_uid="123456",
            email="dev@test.com",
        )
        assert identity.provider == "google"
        assert identity.provider_uid == "123456"


class TestRedirectUriValidation:
    """Test redirect_uri allowlist validation — open redirect prevention."""

    def test_validate_redirect_uri_accepts_allowed_uri(self) -> None:
        from pqdb_api.routes.developer_oauth import _validate_redirect_uri

        allowed = ["http://localhost:3000", "https://dashboard.pqdb.io"]
        _validate_redirect_uri("http://localhost:3000/auth/callback", allowed)

    def test_validate_redirect_uri_rejects_disallowed_uri(self) -> None:
        from pqdb_api.routes.developer_oauth import _validate_redirect_uri

        allowed = ["http://localhost:3000"]
        with pytest.raises(ValueError, match="not in allowed"):
            _validate_redirect_uri("https://evil.com/steal-tokens", allowed)

    def test_validate_redirect_uri_checks_origin_not_full_url(self) -> None:
        from pqdb_api.routes.developer_oauth import _validate_redirect_uri

        allowed = ["http://localhost:3000"]
        _validate_redirect_uri("http://localhost:3000/any/path", allowed)
        _validate_redirect_uri("http://localhost:3000", allowed)

    def test_validate_redirect_uri_rejects_different_port(self) -> None:
        from pqdb_api.routes.developer_oauth import _validate_redirect_uri

        allowed = ["http://localhost:3000"]
        with pytest.raises(ValueError, match="not in allowed"):
            _validate_redirect_uri("http://localhost:4000/callback", allowed)

    def test_validate_redirect_uri_rejects_different_scheme(self) -> None:
        from pqdb_api.routes.developer_oauth import _validate_redirect_uri

        allowed = ["http://localhost:3000"]
        with pytest.raises(ValueError, match="not in allowed"):
            _validate_redirect_uri("https://localhost:3000/callback", allowed)

    def test_validate_redirect_uri_rejects_empty_allowlist(self) -> None:
        from pqdb_api.routes.developer_oauth import _validate_redirect_uri

        with pytest.raises(ValueError, match="not in allowed"):
            _validate_redirect_uri("http://localhost:3000", [])


class TestSettingsAllowedRedirectUris:
    """Test that Settings parses PQDB_ALLOWED_REDIRECT_URIS."""

    def test_default_value(self) -> None:
        from pqdb_api.config import Settings

        settings = Settings(
            database_url="postgresql+asyncpg://x:x@localhost/test",
        )
        assert settings.allowed_redirect_uris == ["http://localhost:3000"]

    def test_custom_value(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from pqdb_api.config import Settings

        monkeypatch.setenv(
            "PQDB_ALLOWED_REDIRECT_URIS_RAW",
            "http://localhost:3000,https://dashboard.pqdb.io",
        )
        settings = Settings(
            database_url="postgresql+asyncpg://x:x@localhost/test",
        )
        assert settings.allowed_redirect_uris == [
            "http://localhost:3000",
            "https://dashboard.pqdb.io",
        ]
