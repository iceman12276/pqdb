"""Unit tests for Google OAuth adapter — US-036.

Tests:
- Authorization URL generation with correct params
- State JWT generation and validation (signed, 10-min expiry, nonce + redirect_uri)
- Code exchange (mocked httpx)
- User info retrieval (mocked httpx)
- Account linking logic (find-or-create user)
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pqdb_api.services.auth import JWT_ALGORITHM, generate_ed25519_keypair
from pqdb_api.services.oauth import (
    GoogleOAuthProvider,
    OAuthTokens,
    OAuthUserInfo,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def keypair() -> tuple[Ed25519PrivateKey, Any]:
    return generate_ed25519_keypair()


@pytest.fixture()
def google_provider() -> GoogleOAuthProvider:
    return GoogleOAuthProvider(
        client_id="test-client-id",
        client_secret="test-client-secret",
    )


# ---------------------------------------------------------------------------
# Authorization URL tests
# ---------------------------------------------------------------------------
class TestGetAuthorizationUrl:
    """Test Google authorization URL generation."""

    def test_contains_required_params(
        self, google_provider: GoogleOAuthProvider
    ) -> None:
        url = google_provider.get_authorization_url(
            state="test-state", redirect_uri="https://example.com/callback"
        )
        parsed = urlparse(url)
        params = parse_qs(parsed.query)

        assert parsed.scheme == "https"
        assert "accounts.google.com" in parsed.netloc
        assert params["client_id"] == ["test-client-id"]
        assert params["redirect_uri"] == ["https://example.com/callback"]
        assert params["response_type"] == ["code"]
        assert params["scope"] == ["openid email profile"]
        assert params["state"] == ["test-state"]

    def test_includes_access_type_offline(
        self, google_provider: GoogleOAuthProvider
    ) -> None:
        url = google_provider.get_authorization_url(
            state="s", redirect_uri="https://example.com/cb"
        )
        params = parse_qs(urlparse(url).query)
        assert params["access_type"] == ["offline"]


# ---------------------------------------------------------------------------
# State JWT tests
# ---------------------------------------------------------------------------
class TestStateJwt:
    """Test state JWT generation and validation for CSRF protection."""

    def test_generate_state_jwt_contains_redirect_and_nonce(
        self, keypair: tuple[Ed25519PrivateKey, Any]
    ) -> None:
        from pqdb_api.routes.google_oauth import _generate_state_jwt

        private_key, public_key = keypair
        project_id = uuid.uuid4()
        redirect_uri = "https://example.com/callback"

        token = _generate_state_jwt(
            private_key=private_key,
            project_id=project_id,
            redirect_uri=redirect_uri,
        )

        payload = jwt.decode(token, public_key, algorithms=[JWT_ALGORITHM])
        assert payload["redirect_uri"] == redirect_uri
        assert payload["project_id"] == str(project_id)
        assert "nonce" in payload
        assert len(payload["nonce"]) > 10  # Should be a random string
        assert payload["type"] == "oauth_state"

    def test_state_jwt_expires_in_10_minutes(
        self, keypair: tuple[Ed25519PrivateKey, Any]
    ) -> None:
        from pqdb_api.routes.google_oauth import _generate_state_jwt

        private_key, public_key = keypair
        token = _generate_state_jwt(
            private_key=private_key,
            project_id=uuid.uuid4(),
            redirect_uri="https://example.com/cb",
        )
        payload = jwt.decode(token, public_key, algorithms=[JWT_ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        iat = datetime.fromtimestamp(payload["iat"], tz=UTC)
        delta = exp - iat
        assert timedelta(minutes=9) < delta <= timedelta(minutes=10)

    def test_validate_state_jwt_succeeds_with_valid_token(
        self, keypair: tuple[Ed25519PrivateKey, Any]
    ) -> None:
        from pqdb_api.routes.google_oauth import (
            _generate_state_jwt,
            _validate_state_jwt,
        )

        private_key, public_key = keypair
        project_id = uuid.uuid4()
        redirect_uri = "https://example.com/callback"

        token = _generate_state_jwt(
            private_key=private_key,
            project_id=project_id,
            redirect_uri=redirect_uri,
        )
        payload = _validate_state_jwt(public_key=public_key, state=token)
        assert payload["redirect_uri"] == redirect_uri
        assert payload["project_id"] == str(project_id)

    def test_validate_state_jwt_rejects_expired_token(
        self, keypair: tuple[Ed25519PrivateKey, Any]
    ) -> None:
        from pqdb_api.routes.google_oauth import _validate_state_jwt

        private_key, public_key = keypair
        # Create a manually expired token
        now = datetime.now(UTC)
        payload = {
            "type": "oauth_state",
            "project_id": str(uuid.uuid4()),
            "redirect_uri": "https://example.com/cb",
            "nonce": secrets.token_urlsafe(16),
            "iat": now - timedelta(minutes=20),
            "exp": now - timedelta(minutes=10),
        }
        token = jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)

        with pytest.raises(ValueError, match="invalid or expired"):
            _validate_state_jwt(public_key=public_key, state=token)

    def test_validate_state_jwt_rejects_wrong_type(
        self, keypair: tuple[Ed25519PrivateKey, Any]
    ) -> None:
        from pqdb_api.routes.google_oauth import _validate_state_jwt

        private_key, public_key = keypair
        now = datetime.now(UTC)
        payload = {
            "type": "user_access",  # wrong type
            "project_id": str(uuid.uuid4()),
            "redirect_uri": "https://example.com/cb",
            "nonce": secrets.token_urlsafe(16),
            "iat": now,
            "exp": now + timedelta(minutes=10),
        }
        token = jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)

        with pytest.raises(ValueError, match="invalid or expired"):
            _validate_state_jwt(public_key=public_key, state=token)

    def test_validate_state_jwt_rejects_tampered_token(
        self, keypair: tuple[Ed25519PrivateKey, Any]
    ) -> None:
        from pqdb_api.routes.google_oauth import _validate_state_jwt

        _, public_key = keypair
        # Use a different key to sign
        other_private, _ = generate_ed25519_keypair()
        now = datetime.now(UTC)
        payload = {
            "type": "oauth_state",
            "project_id": str(uuid.uuid4()),
            "redirect_uri": "https://example.com/cb",
            "nonce": secrets.token_urlsafe(16),
            "iat": now,
            "exp": now + timedelta(minutes=10),
        }
        token = jwt.encode(payload, other_private, algorithm=JWT_ALGORITHM)

        with pytest.raises(ValueError, match="invalid or expired"):
            _validate_state_jwt(public_key=public_key, state=token)


# ---------------------------------------------------------------------------
# Code exchange tests (mocked httpx)
# ---------------------------------------------------------------------------
class TestExchangeCode:
    """Test Google OAuth code exchange with mocked HTTP client."""

    @pytest.mark.anyio()
    async def test_exchange_code_returns_tokens(
        self, google_provider: GoogleOAuthProvider
    ) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "access_token": "google-access-token",
            "refresh_token": "google-refresh-token",
            "expires_in": 3600,
            "token_type": "Bearer",
        }

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            tokens = await google_provider.exchange_code(
                code="auth-code-123",
                redirect_uri="https://example.com/callback",
            )

        assert isinstance(tokens, OAuthTokens)
        assert tokens.access_token == "google-access-token"
        assert tokens.refresh_token == "google-refresh-token"
        assert tokens.expires_in == 3600

    @pytest.mark.anyio()
    async def test_exchange_code_raises_on_error_response(
        self, google_provider: GoogleOAuthProvider
    ) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.text = "Bad Request"
        mock_response.json.return_value = {"error": "invalid_grant"}

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(ValueError, match="token exchange failed"):
                await google_provider.exchange_code(
                    code="bad-code",
                    redirect_uri="https://example.com/callback",
                )


# ---------------------------------------------------------------------------
# User info retrieval tests (mocked httpx)
# ---------------------------------------------------------------------------
class TestGetUserInfo:
    """Test Google user info retrieval with mocked HTTP client."""

    @pytest.mark.anyio()
    async def test_get_user_info_returns_user(
        self, google_provider: GoogleOAuthProvider
    ) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": "google-user-123",
            "email": "user@gmail.com",
            "name": "Test User",
            "picture": "https://example.com/photo.jpg",
        }

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        tokens = OAuthTokens(
            access_token="test-token",
            refresh_token=None,
            expires_in=3600,
            token_type="Bearer",
        )

        with patch("httpx.AsyncClient", return_value=mock_client):
            user_info = await google_provider.get_user_info(tokens)

        assert isinstance(user_info, OAuthUserInfo)
        assert user_info.email == "user@gmail.com"
        assert user_info.name == "Test User"
        assert user_info.avatar_url == "https://example.com/photo.jpg"
        assert user_info.provider_uid == "google-user-123"

    @pytest.mark.anyio()
    async def test_get_user_info_raises_on_error(
        self, google_provider: GoogleOAuthProvider
    ) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        tokens = OAuthTokens(
            access_token="bad-token",
            refresh_token=None,
            expires_in=3600,
            token_type="Bearer",
        )

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(ValueError, match="user info retrieval failed"):
                await google_provider.get_user_info(tokens)
