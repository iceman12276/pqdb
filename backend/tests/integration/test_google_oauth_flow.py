"""Integration tests for Google OAuth flow — US-036.

Boots real FastAPI app with real Postgres, mocks external Google API calls
(httpx responses), tests the full flow:
- GET /authorize → redirect to Google with state JWT
- GET /callback → validate state, exchange code, create/link user, redirect with tokens
- Account linking (existing user, new user)
- Error cases (no OAuth config, invalid state, etc.)
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

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
from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.routes.google_oauth import router as google_oauth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import (
    _build_mldsa65_token,
    decode_token,
    generate_mldsa65_keypair,
)
from pqdb_api.services.vault import VaultClient, VaultError


def _make_google_oauth_app(
    test_db_url: str,
    *,
    google_configured: bool = True,
    client_id: str = "test-google-client-id",
    client_secret: str = "test-google-client-secret",
) -> tuple[FastAPI, uuid.UUID]:
    """Build a test app with Google OAuth routes backed by real Postgres.

    Returns (app, project_id) tuple.
    """
    private_key, public_key = generate_mldsa65_keypair()
    project_id = uuid.uuid4()

    # Mock vault with in-memory OAuth credential store
    oauth_store: dict[str, dict[str, dict[str, str]]] = {}

    if google_configured:
        oauth_store[str(project_id)] = {
            "google": {
                "client_id": client_id,
                "client_secret": client_secret,
            }
        }

    mock_vault = MagicMock(spec=VaultClient)

    def _mock_get_oauth(pid: uuid.UUID, provider: str) -> dict[str, Any]:
        pid_str = str(pid)
        if pid_str not in oauth_store or provider not in oauth_store[pid_str]:
            raise VaultError("Not found")
        return oauth_store[pid_str][provider]

    mock_vault.get_oauth_credentials = MagicMock(side_effect=_mock_get_oauth)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        async def _override_project_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        async def _override_project_context() -> ProjectContext:
            return ProjectContext(
                project_id=project_id,
                key_role="anon",
                database_name="test",
            )

        app.dependency_overrides[get_session] = _override_get_session
        app.dependency_overrides[get_project_session] = _override_project_session
        app.dependency_overrides[get_project_context] = _override_project_context
        app.state.mldsa65_private_key = private_key
        app.state.mldsa65_public_key = public_key
        app.state.vault_client = mock_vault
        app.state.settings = Settings(
            database_url=test_db_url,
            allowed_redirect_uris_raw=("https://myapp.com,http://localhost:3000"),
        )
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(google_oauth_router)
    app.include_router(user_auth_router)
    return app, project_id


@pytest.fixture()
def google_app(test_db_url: str) -> tuple[FastAPI, uuid.UUID]:
    return _make_google_oauth_app(test_db_url)


@pytest.fixture()
def client(google_app: tuple[FastAPI, uuid.UUID]) -> Iterator[TestClient]:
    app, _ = google_app
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def project_id(google_app: tuple[FastAPI, uuid.UUID]) -> uuid.UUID:
    _, pid = google_app
    return pid


@pytest.fixture()
def unconfigured_client(test_db_url: str) -> Iterator[TestClient]:
    app, _ = _make_google_oauth_app(test_db_url, google_configured=False)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _mock_google_token_response(
    access_token: str = "google-access-token",
    refresh_token: str = "google-refresh-token",
) -> MagicMock:
    """Create a mock httpx response for Google token exchange."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": 3600,
        "token_type": "Bearer",
    }
    return mock_resp


def _mock_google_userinfo_response(
    email: str = "user@gmail.com",
    user_id: str = "google-user-123",
    name: str = "Test User",
) -> MagicMock:
    """Create a mock httpx response for Google userinfo."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "id": user_id,
        "email": email,
        "name": name,
        "picture": "https://example.com/photo.jpg",
    }
    return mock_resp


def _create_mock_httpx_client(
    token_response: MagicMock | None = None,
    userinfo_response: MagicMock | None = None,
) -> AsyncMock:
    """Create a mock httpx.AsyncClient for Google API calls."""
    if token_response is None:
        token_response = _mock_google_token_response()
    if userinfo_response is None:
        userinfo_response = _mock_google_userinfo_response()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=token_response)
    mock_client.get = AsyncMock(return_value=userinfo_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


def _generate_valid_state(app: FastAPI, project_id: uuid.UUID) -> str:
    """Generate a valid state JWT for testing the callback."""
    from pqdb_api.routes.google_oauth import _generate_state_jwt

    return _generate_state_jwt(
        private_key=app.state.mldsa65_private_key,
        project_id=project_id,
        redirect_uri="https://myapp.com/auth/callback",
    )


# ---------------------------------------------------------------------------
# Route existence tests
# ---------------------------------------------------------------------------
class TestRoutesExist:
    """Verify Google OAuth routes are registered."""

    def test_authorize_route_exists(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/google/authorize",
            params={"redirect_uri": "https://example.com/cb"},
            follow_redirects=False,
        )
        assert resp.status_code != 404

    def test_callback_route_exists(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/google/callback",
            params={"code": "test", "state": "test"},
            follow_redirects=False,
        )
        assert resp.status_code != 404

    def test_health_check_works(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Authorize endpoint tests
# ---------------------------------------------------------------------------
class TestAuthorize:
    """Tests for GET /v1/auth/users/oauth/google/authorize."""

    def test_redirects_to_google(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/google/authorize",
            params={"redirect_uri": "https://myapp.com/auth/callback"},
            follow_redirects=False,
        )
        assert resp.status_code == 302
        location = resp.headers["location"]
        assert "accounts.google.com" in location

    def test_redirect_contains_state_jwt(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/google/authorize",
            params={"redirect_uri": "https://myapp.com/auth/callback"},
            follow_redirects=False,
        )
        location = resp.headers["location"]
        parsed = urlparse(location)
        params = parse_qs(parsed.query)
        assert "state" in params
        # State should be a valid JWT
        state = params["state"][0]
        assert len(state) > 20  # JWT is always long

    def test_redirect_contains_correct_scope(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/google/authorize",
            params={"redirect_uri": "https://myapp.com/cb"},
            follow_redirects=False,
        )
        location = resp.headers["location"]
        params = parse_qs(urlparse(location).query)
        assert params["scope"] == ["openid email profile"]
        assert params["response_type"] == ["code"]

    def test_returns_400_if_google_not_configured(
        self, unconfigured_client: TestClient
    ) -> None:
        resp = unconfigured_client.get(
            "/v1/auth/users/oauth/google/authorize",
            params={"redirect_uri": "https://myapp.com/cb"},
            follow_redirects=False,
        )
        assert resp.status_code == 400
        assert "not configured" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Callback endpoint tests
# ---------------------------------------------------------------------------
class TestCallback:
    """Tests for GET /v1/auth/users/oauth/google/callback."""

    def test_creates_new_user_and_redirects_with_tokens(
        self, google_app: tuple[FastAPI, uuid.UUID]
    ) -> None:
        app, project_id = google_app
        mock_client = _create_mock_httpx_client()

        with TestClient(app, raise_server_exceptions=False) as client:
            state = _generate_valid_state(app, project_id)

            with patch("httpx.AsyncClient", return_value=mock_client):
                resp = client.get(
                    "/v1/auth/users/oauth/google/callback",
                    params={"code": "google-auth-code", "state": state},
                    follow_redirects=False,
                )

            assert resp.status_code == 302
            location = resp.headers["location"]
            assert location.startswith("https://myapp.com/auth/callback#")

            # Parse fragment params
            fragment = urlparse(location).fragment
            params = parse_qs(fragment)
            assert "access_token" in params
            assert "refresh_token" in params
            assert params["token_type"] == ["bearer"]

    def test_links_existing_user_with_verified_email(self, test_db_url: str) -> None:
        """If a user with matching email exists, link the Google identity."""
        app, project_id = _make_google_oauth_app(test_db_url)
        mock_client = _create_mock_httpx_client(
            userinfo_response=_mock_google_userinfo_response(
                email="existing@gmail.com"
            ),
        )

        with TestClient(app, raise_server_exceptions=False) as client:
            # First, create an existing user via signup
            # We need to add user_auth router for signup
            signup_resp = client.post(
                "/v1/auth/users/signup",
                json={"email": "existing@gmail.com", "password": "password123"},
                headers={"apikey": "pqdb_anon_dummy"},
            )
            assert signup_resp.status_code == 201
            original_user_id = signup_resp.json()["user"]["id"]

            # Now do the OAuth callback
            state = _generate_valid_state(app, project_id)
            with patch("httpx.AsyncClient", return_value=mock_client):
                resp = client.get(
                    "/v1/auth/users/oauth/google/callback",
                    params={"code": "google-auth-code", "state": state},
                    follow_redirects=False,
                )

            assert resp.status_code == 302
            # The user ID in the token should match the existing user
            location = resp.headers["location"]
            fragment = urlparse(location).fragment
            params = parse_qs(fragment)
            access_token = params["access_token"][0]

            # Decode the access token to check user_id
            payload = decode_token(
                access_token,
                app.state.mldsa65_public_key,
            )
            assert payload["sub"] == original_user_id

    def test_returns_400_for_invalid_state(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/google/callback",
            params={"code": "google-auth-code", "state": "invalid-jwt"},
            follow_redirects=False,
        )
        assert resp.status_code == 400
        assert "invalid or expired" in resp.json()["detail"].lower()

    def test_returns_400_for_expired_state(
        self, google_app: tuple[FastAPI, uuid.UUID]
    ) -> None:
        app, project_id = google_app

        with TestClient(app, raise_server_exceptions=False) as client:
            # Create an expired state JWT
            now = datetime.now(UTC)
            payload = {
                "type": "oauth_state",
                "project_id": str(project_id),
                "redirect_uri": "https://myapp.com/cb",
                "nonce": secrets.token_urlsafe(16),
                "iat": int((now - timedelta(minutes=20)).timestamp()),
                "exp": int((now - timedelta(minutes=10)).timestamp()),
            }
            expired_state = _build_mldsa65_token(payload, app.state.mldsa65_private_key)

            resp = client.get(
                "/v1/auth/users/oauth/google/callback",
                params={"code": "google-auth-code", "state": expired_state},
                follow_redirects=False,
            )
            assert resp.status_code == 400

    def test_returns_400_if_google_not_configured(self, test_db_url: str) -> None:
        app, project_id = _make_google_oauth_app(test_db_url, google_configured=False)

        with TestClient(app, raise_server_exceptions=False) as client:
            # Generate state with a different key (since unconfigured app
            # still has JWT keys)
            state = _generate_valid_state(app, project_id)

            resp = client.get(
                "/v1/auth/users/oauth/google/callback",
                params={"code": "google-auth-code", "state": state},
                follow_redirects=False,
            )
            assert resp.status_code == 400
            assert "not configured" in resp.json()["detail"]

    def test_returns_400_if_code_exchange_fails(
        self, google_app: tuple[FastAPI, uuid.UUID]
    ) -> None:
        app, project_id = google_app

        # Mock a failed token exchange
        mock_token_resp = MagicMock()
        mock_token_resp.status_code = 400
        mock_token_resp.text = "Bad Request"
        mock_token_resp.json.return_value = {"error": "invalid_grant"}

        mock_client = _create_mock_httpx_client(token_response=mock_token_resp)

        with TestClient(app, raise_server_exceptions=False) as client:
            state = _generate_valid_state(app, project_id)

            with patch("httpx.AsyncClient", return_value=mock_client):
                resp = client.get(
                    "/v1/auth/users/oauth/google/callback",
                    params={"code": "bad-code", "state": state},
                    follow_redirects=False,
                )

            assert resp.status_code == 400
            assert "exchange" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Full lifecycle tests
# ---------------------------------------------------------------------------
class TestFullOAuthLifecycle:
    """End-to-end: authorize → callback → user created → JWT issued."""

    def test_full_flow_new_user(self, google_app: tuple[FastAPI, uuid.UUID]) -> None:
        """Full flow: authorize → callback → new user created with tokens."""
        app, project_id = google_app
        mock_client = _create_mock_httpx_client()

        with TestClient(app, raise_server_exceptions=False) as client:
            # Step 1: Authorize — get redirect to Google
            resp = client.get(
                "/v1/auth/users/oauth/google/authorize",
                params={"redirect_uri": "https://myapp.com/auth/callback"},
                follow_redirects=False,
            )
            assert resp.status_code == 302
            location = resp.headers["location"]
            google_params = parse_qs(urlparse(location).query)
            state = google_params["state"][0]

            # Step 2: Callback — simulate Google redirect back
            with patch("httpx.AsyncClient", return_value=mock_client):
                resp = client.get(
                    "/v1/auth/users/oauth/google/callback",
                    params={"code": "google-auth-code", "state": state},
                    follow_redirects=False,
                )

            assert resp.status_code == 302
            callback_location = resp.headers["location"]
            assert callback_location.startswith("https://myapp.com/auth/callback#")

            # Step 3: Verify tokens in fragment
            fragment = urlparse(callback_location).fragment
            token_params = parse_qs(fragment)
            access_token = token_params["access_token"][0]

            # Decode and verify the access token
            payload = decode_token(
                access_token,
                app.state.mldsa65_public_key,
            )
            assert payload["type"] == "user_access"
            assert payload["role"] == "authenticated"
            assert payload["email_verified"] is True
            assert payload["project_id"] == str(project_id)

    def test_full_flow_existing_user_linked(self, test_db_url: str) -> None:
        """Full flow: existing user gets Google identity linked."""
        app, project_id = _make_google_oauth_app(test_db_url)
        email = "linked@gmail.com"

        mock_client = _create_mock_httpx_client(
            userinfo_response=_mock_google_userinfo_response(email=email),
        )

        with TestClient(app, raise_server_exceptions=False) as client:
            # Create existing user via signup
            signup_resp = client.post(
                "/v1/auth/users/signup",
                json={"email": email, "password": "password123"},
                headers={"apikey": "pqdb_anon_dummy"},
            )
            assert signup_resp.status_code == 201
            original_user_id = signup_resp.json()["user"]["id"]

            # OAuth flow
            state = _generate_valid_state(app, project_id)
            with patch("httpx.AsyncClient", return_value=mock_client):
                resp = client.get(
                    "/v1/auth/users/oauth/google/callback",
                    params={"code": "auth-code", "state": state},
                    follow_redirects=False,
                )

            assert resp.status_code == 302
            fragment = urlparse(resp.headers["location"]).fragment
            token_params = parse_qs(fragment)
            access_token = token_params["access_token"][0]

            payload = decode_token(
                access_token,
                app.state.mldsa65_public_key,
            )
            # Same user, now with email_verified = true
            assert payload["sub"] == original_user_id
            assert payload["email_verified"] is True
