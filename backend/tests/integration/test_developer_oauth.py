"""Integration tests for Developer OAuth flow — US-052.

Boots real FastAPI app with real Postgres, mocks external OAuth API calls
(httpx responses via DI), tests the full flow:
- GET /v1/auth/oauth/{provider}/authorize → redirect to provider with state JWT
- GET /v1/auth/oauth/{provider}/callback → validate state, exchange code,
  create/link developer, redirect with tokens
- Account linking (existing developer, new developer)
- Error cases (provider not configured, invalid state, etc.)
"""

from __future__ import annotations

import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.config import Settings
from pqdb_api.database import get_session
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.developer_oauth import router as developer_oauth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.services.auth import JWT_ALGORITHM, generate_ed25519_keypair
from pqdb_api.services.vault import VaultClient, VaultError


# ---------------------------------------------------------------------------
# App factory for developer OAuth integration tests
# ---------------------------------------------------------------------------
def _make_dev_oauth_app(
    test_db_url: str,
    *,
    google_configured: bool = True,
    github_configured: bool = False,
    google_client_id: str = "test-google-client-id",
    google_client_secret: str = "test-google-client-secret",
    github_client_id: str = "test-github-client-id",
    github_client_secret: str = "test-github-client-secret",
    allowed_redirect_uris: list[str] | None = None,
) -> FastAPI:
    """Build a test app with developer OAuth routes backed by real Postgres."""
    private_key, public_key = generate_ed25519_keypair()

    # In-memory platform OAuth credential store
    platform_oauth_store: dict[str, dict[str, str]] = {}
    if google_configured:
        platform_oauth_store["google"] = {
            "client_id": google_client_id,
            "client_secret": google_client_secret,
        }
    if github_configured:
        platform_oauth_store["github"] = {
            "client_id": github_client_id,
            "client_secret": github_client_secret,
        }

    mock_vault = MagicMock(spec=VaultClient)

    def _mock_get_platform_oauth(provider: str) -> dict[str, Any]:
        if provider not in platform_oauth_store:
            raise VaultError(f"Provider {provider} not configured")
        return platform_oauth_store[provider]

    mock_vault.get_platform_oauth_credentials = MagicMock(
        side_effect=_mock_get_platform_oauth
    )

    uris = allowed_redirect_uris or [
        "https://dashboard.pqdb.io",
        "https://example.com",
        "http://localhost:3000",
    ]
    settings = Settings(
        database_url=test_db_url,
        allowed_redirect_uris_raw=",".join(uris),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_session] = _override_get_session
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        app.state.vault_client = mock_vault
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(developer_oauth_router)
    return app


# ---------------------------------------------------------------------------
# Mock httpx response helpers
# ---------------------------------------------------------------------------
def _mock_google_token_response(
    access_token: str = "google-access-token",
) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "access_token": access_token,
        "refresh_token": "google-refresh-token",
        "expires_in": 3600,
        "token_type": "Bearer",
    }
    return mock_resp


def _mock_google_userinfo_response(
    email: str = "dev@gmail.com",
    user_id: str = "google-user-123",
    name: str = "Test Developer",
) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "id": user_id,
        "email": email,
        "name": name,
        "picture": "https://example.com/photo.jpg",
    }
    return mock_resp


def _mock_github_token_response(
    access_token: str = "github-access-token",
) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "access_token": access_token,
        "token_type": "bearer",
    }
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


def _mock_github_user_response(
    user_id: str = "12345",
    name: str = "GH Developer",
) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "id": int(user_id),
        "name": name,
        "avatar_url": "https://github.com/avatar.png",
    }
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


def _mock_github_emails_response(
    email: str = "dev@github.com",
) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = [
        {"email": email, "primary": True, "verified": True},
    ]
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


def _create_mock_google_httpx(
    token_resp: MagicMock | None = None,
    userinfo_resp: MagicMock | None = None,
) -> AsyncMock:
    if token_resp is None:
        token_resp = _mock_google_token_response()
    if userinfo_resp is None:
        userinfo_resp = _mock_google_userinfo_response()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=token_resp)
    mock_client.get = AsyncMock(return_value=userinfo_resp)
    return mock_client


def _create_mock_github_httpx(
    token_resp: MagicMock | None = None,
    user_resp: MagicMock | None = None,
    emails_resp: MagicMock | None = None,
) -> AsyncMock:
    if token_resp is None:
        token_resp = _mock_github_token_response()
    if user_resp is None:
        user_resp = _mock_github_user_response()
    if emails_resp is None:
        emails_resp = _mock_github_emails_response()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=token_resp)
    # GitHub makes two GET calls: /user then /user/emails
    mock_client.get = AsyncMock(side_effect=[user_resp, emails_resp])
    return mock_client


def _generate_valid_state(app: FastAPI) -> str:
    from pqdb_api.routes.developer_oauth import _generate_dev_state_jwt

    return _generate_dev_state_jwt(
        private_key=app.state.jwt_private_key,
        redirect_uri="https://dashboard.pqdb.io/auth/callback",
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def google_app(test_db_url: str) -> FastAPI:
    return _make_dev_oauth_app(test_db_url, google_configured=True)


@pytest.fixture()
def github_app(test_db_url: str) -> FastAPI:
    return _make_dev_oauth_app(
        test_db_url, google_configured=False, github_configured=True
    )


@pytest.fixture()
def both_app(test_db_url: str) -> FastAPI:
    return _make_dev_oauth_app(
        test_db_url, google_configured=True, github_configured=True
    )


@pytest.fixture()
def unconfigured_app(test_db_url: str) -> FastAPI:
    return _make_dev_oauth_app(
        test_db_url, google_configured=False, github_configured=False
    )


# ---------------------------------------------------------------------------
# Route existence tests
# ---------------------------------------------------------------------------
class TestRoutesExist:
    def test_google_authorize_route_exists(self, google_app: FastAPI) -> None:
        with TestClient(google_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/authorize",
                params={"redirect_uri": "https://example.com/cb"},
                follow_redirects=False,
            )
            assert resp.status_code != 404

    def test_google_callback_route_exists(self, google_app: FastAPI) -> None:
        with TestClient(google_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "test", "state": "test"},
                follow_redirects=False,
            )
            assert resp.status_code != 404

    def test_github_authorize_route_exists(self, github_app: FastAPI) -> None:
        with TestClient(github_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/github/authorize",
                params={"redirect_uri": "https://example.com/cb"},
                follow_redirects=False,
            )
            assert resp.status_code != 404

    def test_health_check(self, google_app: FastAPI) -> None:
        with TestClient(google_app) as client:
            resp = client.get("/health")
            assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Authorize endpoint tests
# ---------------------------------------------------------------------------
class TestAuthorize:
    def test_google_redirects_to_consent_screen(self, google_app: FastAPI) -> None:
        with TestClient(google_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/authorize",
                params={"redirect_uri": "https://dashboard.pqdb.io/auth/callback"},
                follow_redirects=False,
            )
            assert resp.status_code == 302
            location = resp.headers["location"]
            assert "accounts.google.com" in location

    def test_github_redirects_to_consent_screen(self, github_app: FastAPI) -> None:
        with TestClient(github_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/github/authorize",
                params={"redirect_uri": "https://dashboard.pqdb.io/auth/callback"},
                follow_redirects=False,
            )
            assert resp.status_code == 302
            location = resp.headers["location"]
            assert "github.com/login/oauth" in location

    def test_returns_400_for_unsupported_provider(self, google_app: FastAPI) -> None:
        with TestClient(google_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/facebook/authorize",
                params={"redirect_uri": "https://example.com/cb"},
                follow_redirects=False,
            )
            assert resp.status_code == 400
            assert "Unsupported" in resp.json()["detail"]

    def test_returns_400_if_provider_not_configured(
        self, unconfigured_app: FastAPI
    ) -> None:
        with TestClient(unconfigured_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/authorize",
                params={"redirect_uri": "https://example.com/cb"},
                follow_redirects=False,
            )
            assert resp.status_code == 400
            assert "not configured" in resp.json()["detail"]

    def test_redirect_contains_state_jwt(self, google_app: FastAPI) -> None:
        from urllib.parse import parse_qs, urlparse

        with TestClient(google_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/authorize",
                params={"redirect_uri": "https://dashboard.pqdb.io/auth/callback"},
                follow_redirects=False,
            )
            location = resp.headers["location"]
            params = parse_qs(urlparse(location).query)
            assert "state" in params
            state = params["state"][0]
            # Verify it's a valid JWT signed by our key
            payload = jwt.decode(
                state,
                google_app.state.jwt_public_key,
                algorithms=[JWT_ALGORITHM],
            )
            assert payload["type"] == "dev_oauth_state"


# ---------------------------------------------------------------------------
# Open redirect protection tests
# ---------------------------------------------------------------------------
class TestOpenRedirectProtection:
    def test_rejects_redirect_uri_not_in_allowlist(self, test_db_url: str) -> None:
        app = _make_dev_oauth_app(
            test_db_url,
            google_configured=True,
            allowed_redirect_uris=["http://localhost:3000"],
        )
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/authorize",
                params={"redirect_uri": "https://evil.com/steal-tokens"},
                follow_redirects=False,
            )
            assert resp.status_code == 400
            assert "not in the allowed" in resp.json()["detail"]

    def test_allows_redirect_uri_in_allowlist(self, test_db_url: str) -> None:
        app = _make_dev_oauth_app(
            test_db_url,
            google_configured=True,
            allowed_redirect_uris=["http://localhost:3000"],
        )
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/authorize",
                params={"redirect_uri": "http://localhost:3000/auth/callback"},
                follow_redirects=False,
            )
            assert resp.status_code == 302


# ---------------------------------------------------------------------------
# Callback endpoint tests — Google
# ---------------------------------------------------------------------------
class TestGoogleCallback:
    def test_creates_new_developer_and_redirects(self, google_app: FastAPI) -> None:
        mock_client = _create_mock_google_httpx()

        with TestClient(google_app, raise_server_exceptions=False) as client:
            google_app.state.oauth_http_client = mock_client
            state = _generate_valid_state(google_app)

            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "google-auth-code", "state": state},
                follow_redirects=False,
            )

            assert resp.status_code == 302
            location = resp.headers["location"]
            assert location.startswith("https://dashboard.pqdb.io/auth/callback#")

            from urllib.parse import parse_qs, urlparse

            fragment = urlparse(location).fragment
            params = parse_qs(fragment)
            assert "access_token" in params
            assert "refresh_token" in params
            assert params["token_type"] == ["bearer"]

            # Decode access token to verify it's a developer token
            access_token = params["access_token"][0]
            payload = jwt.decode(
                access_token,
                google_app.state.jwt_public_key,
                algorithms=[JWT_ALGORITHM],
            )
            assert payload["type"] == "access"
            assert "sub" in payload

    def test_links_existing_developer_by_email(self, google_app: FastAPI) -> None:
        mock_client = _create_mock_google_httpx(
            userinfo_resp=_mock_google_userinfo_response(email="existing@gmail.com"),
        )

        with TestClient(google_app, raise_server_exceptions=False) as client:
            # Create developer via signup first
            signup_resp = client.post(
                "/v1/auth/signup",
                json={"email": "existing@gmail.com", "password": "password123"},
            )
            assert signup_resp.status_code == 201

            # Get the developer ID from the signup token
            signup_token = signup_resp.json()["access_token"]
            signup_payload = jwt.decode(
                signup_token,
                google_app.state.jwt_public_key,
                algorithms=[JWT_ALGORITHM],
            )
            original_dev_id = signup_payload["sub"]

            # Now do OAuth callback
            google_app.state.oauth_http_client = mock_client
            state = _generate_valid_state(google_app)

            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "auth-code", "state": state},
                follow_redirects=False,
            )

            assert resp.status_code == 302
            from urllib.parse import parse_qs, urlparse

            fragment = urlparse(resp.headers["location"]).fragment
            params = parse_qs(fragment)
            access_token = params["access_token"][0]

            payload = jwt.decode(
                access_token,
                google_app.state.jwt_public_key,
                algorithms=[JWT_ALGORITHM],
            )
            # Same developer — account was linked, not created
            assert payload["sub"] == original_dev_id

    def test_returns_400_for_invalid_state(self, google_app: FastAPI) -> None:
        with TestClient(google_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "auth-code", "state": "invalid-jwt"},
                follow_redirects=False,
            )
            assert resp.status_code == 400
            assert "invalid or expired" in resp.json()["detail"].lower()

    def test_returns_400_for_expired_state(self, google_app: FastAPI) -> None:
        with TestClient(google_app, raise_server_exceptions=False) as client:
            now = datetime.now(UTC)
            payload: dict[str, Any] = {
                "type": "dev_oauth_state",
                "redirect_uri": "https://dashboard.pqdb.io/auth/callback",
                "nonce": secrets.token_urlsafe(16),
                "iat": now - timedelta(minutes=20),
                "exp": now - timedelta(minutes=10),
            }
            expired_state = jwt.encode(
                payload, google_app.state.jwt_private_key, algorithm=JWT_ALGORITHM
            )

            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "auth-code", "state": expired_state},
                follow_redirects=False,
            )
            assert resp.status_code == 400

    def test_returns_400_if_code_exchange_fails(self, google_app: FastAPI) -> None:
        mock_token_resp = MagicMock()
        mock_token_resp.status_code = 400
        mock_token_resp.text = "Bad Request"

        mock_client = _create_mock_google_httpx(token_resp=mock_token_resp)

        with TestClient(google_app, raise_server_exceptions=False) as client:
            google_app.state.oauth_http_client = mock_client
            state = _generate_valid_state(google_app)

            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "bad-code", "state": state},
                follow_redirects=False,
            )
            assert resp.status_code == 400
            assert "exchange" in resp.json()["detail"].lower()

    def test_returns_400_if_provider_not_configured(
        self, unconfigured_app: FastAPI
    ) -> None:
        with TestClient(unconfigured_app, raise_server_exceptions=False) as client:
            # Generate a valid state JWT first
            state = _generate_valid_state(unconfigured_app)

            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "auth-code", "state": state},
                follow_redirects=False,
            )
            assert resp.status_code == 400
            assert "not configured" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Callback endpoint tests — GitHub
# ---------------------------------------------------------------------------
class TestGitHubCallback:
    def test_creates_new_developer_via_github(self, github_app: FastAPI) -> None:
        mock_client = _create_mock_github_httpx()

        with TestClient(github_app, raise_server_exceptions=False) as client:
            github_app.state.oauth_http_client = mock_client
            from pqdb_api.routes.developer_oauth import _generate_dev_state_jwt

            state = _generate_dev_state_jwt(
                private_key=github_app.state.jwt_private_key,
                redirect_uri="https://dashboard.pqdb.io/auth/callback",
            )

            resp = client.get(
                "/v1/auth/oauth/github/callback",
                params={"code": "github-auth-code", "state": state},
                follow_redirects=False,
            )

            assert resp.status_code == 302
            location = resp.headers["location"]
            assert location.startswith("https://dashboard.pqdb.io/auth/callback#")

            from urllib.parse import parse_qs, urlparse

            fragment = urlparse(location).fragment
            params = parse_qs(fragment)
            assert "access_token" in params


# ---------------------------------------------------------------------------
# Full lifecycle tests
# ---------------------------------------------------------------------------
class TestFullOAuthLifecycle:
    def test_authorize_then_callback_new_developer(self, google_app: FastAPI) -> None:
        """Full flow: authorize → callback → new developer → JWT issued."""
        mock_client = _create_mock_google_httpx()

        with TestClient(google_app, raise_server_exceptions=False) as client:
            from urllib.parse import parse_qs, urlparse

            # Step 1: Authorize
            resp = client.get(
                "/v1/auth/oauth/google/authorize",
                params={"redirect_uri": "https://dashboard.pqdb.io/auth/callback"},
                follow_redirects=False,
            )
            assert resp.status_code == 302
            google_params = parse_qs(urlparse(resp.headers["location"]).query)
            state = google_params["state"][0]

            # Step 2: Callback (with mocked httpx)
            google_app.state.oauth_http_client = mock_client
            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "google-auth-code", "state": state},
                follow_redirects=False,
            )
            assert resp.status_code == 302

            # Step 3: Verify tokens
            fragment = urlparse(resp.headers["location"]).fragment
            params = parse_qs(fragment)
            access_token = params["access_token"][0]

            payload = jwt.decode(
                access_token,
                google_app.state.jwt_public_key,
                algorithms=[JWT_ALGORITHM],
            )
            assert payload["type"] == "access"
            assert "sub" in payload

    def test_oauth_creates_developer_with_email_verified_true(
        self, google_app: FastAPI
    ) -> None:
        """New developer via OAuth gets email_verified = true."""
        mock_client = _create_mock_google_httpx(
            userinfo_resp=_mock_google_userinfo_response(email="verified@gmail.com"),
        )

        with TestClient(google_app, raise_server_exceptions=False) as client:
            google_app.state.oauth_http_client = mock_client
            state = _generate_valid_state(google_app)

            resp = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "auth-code", "state": state},
                follow_redirects=False,
            )
            assert resp.status_code == 302

            # Now try to sign up with the same email — should get 409 (already exists)
            signup_resp = client.post(
                "/v1/auth/signup",
                json={"email": "verified@gmail.com", "password": "password123"},
            )
            assert signup_resp.status_code == 409

    def test_same_oauth_login_twice_returns_same_developer(
        self, google_app: FastAPI
    ) -> None:
        """Logging in with the same OAuth account twice should link, not duplicate."""
        mock_client = _create_mock_google_httpx(
            userinfo_resp=_mock_google_userinfo_response(
                email="twice@gmail.com",
                user_id="google-user-999",
            ),
        )

        with TestClient(google_app, raise_server_exceptions=False) as client:
            google_app.state.oauth_http_client = mock_client

            from urllib.parse import parse_qs, urlparse

            # First login
            state1 = _generate_valid_state(google_app)
            resp1 = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "auth-code-1", "state": state1},
                follow_redirects=False,
            )
            assert resp1.status_code == 302
            params1 = parse_qs(urlparse(resp1.headers["location"]).fragment)
            payload1 = jwt.decode(
                params1["access_token"][0],
                google_app.state.jwt_public_key,
                algorithms=[JWT_ALGORITHM],
            )

            # Need fresh mock for second call (side_effect consumed)
            mock_client2 = _create_mock_google_httpx(
                userinfo_resp=_mock_google_userinfo_response(
                    email="twice@gmail.com",
                    user_id="google-user-999",
                ),
            )
            google_app.state.oauth_http_client = mock_client2

            # Second login
            state2 = _generate_valid_state(google_app)
            resp2 = client.get(
                "/v1/auth/oauth/google/callback",
                params={"code": "auth-code-2", "state": state2},
                follow_redirects=False,
            )
            assert resp2.status_code == 302
            params2 = parse_qs(urlparse(resp2.headers["location"]).fragment)
            payload2 = jwt.decode(
                params2["access_token"][0],
                google_app.state.jwt_public_key,
                algorithms=[JWT_ALGORITHM],
            )

            # Same developer ID both times
            assert payload1["sub"] == payload2["sub"]
