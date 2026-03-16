"""Integration tests for GitHub OAuth login flow.

Boots the real FastAPI app with real Postgres, mocks external GitHub API calls,
tests the full authorize -> callback -> user created/linked -> JWT issued flow.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.oauth_github import router as oauth_github_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.oauth import GitHubOAuthProvider, OAuthTokens, OAuthUserInfo
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient

_AppTuple = tuple[FastAPI, uuid.UUID, Ed25519PrivateKey, Ed25519PublicKey]


def _make_github_oauth_app(
    test_db_url: str,
    github_configured: bool = True,
) -> _AppTuple:
    """Build a test app with GitHub OAuth routes backed by real Postgres.

    Uses dependency overrides to bypass API key validation and connect
    directly to the test database for project-scoped operations.
    """
    from pqdb_api.config import Settings
    from pqdb_api.middleware.api_key import (
        ProjectContext,
        get_project_context,
        get_project_session,
    )

    private_key, public_key = generate_ed25519_keypair()
    project_id = uuid.uuid4()

    # Mock vault with in-memory OAuth credential store
    oauth_store: dict[str, dict[str, dict[str, str]]] = {}

    if github_configured:
        oauth_store[str(project_id)] = {
            "github": {
                "client_id": "test-github-client-id",
                "client_secret": "test-github-client-secret",
            }
        }

    mock_vault = MagicMock(spec=VaultClient)

    def _mock_get_oauth(pid: uuid.UUID, provider: str) -> dict[str, Any]:
        pid_str = str(pid)
        if pid_str not in oauth_store or provider not in oauth_store[pid_str]:
            from pqdb_api.services.vault import VaultError

            raise VaultError("Not found")
        return oauth_store[pid_str][provider]

    mock_vault.get_oauth_credentials = MagicMock(side_effect=_mock_get_oauth)

    settings = Settings(
        database_url=test_db_url,
        superuser_dsn="postgresql://test:test@localhost/test",
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
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        app.state.vault_client = mock_vault
        app.state.settings = settings
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(user_auth_router)
    app.include_router(oauth_github_router)
    return app, project_id, private_key, public_key


@pytest.fixture()
def github_app(test_db_url: str) -> _AppTuple:
    return _make_github_oauth_app(test_db_url)


@pytest.fixture()
def client(github_app: _AppTuple) -> Iterator[TestClient]:
    app = github_app[0]
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def project_id(github_app: _AppTuple) -> uuid.UUID:
    return github_app[1]


@pytest.fixture()
def jwt_keys(
    github_app: _AppTuple,
) -> tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    return github_app[2], github_app[3]


@pytest.fixture()
def unconfigured_client(test_db_url: str) -> Iterator[TestClient]:
    app, _, _, _ = _make_github_oauth_app(test_db_url, github_configured=False)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


class TestGitHubOAuthRoutesExist:
    """Verify GitHub OAuth routes are registered and return non-404."""

    def test_authorize_route_exists(self, client: TestClient) -> None:
        # Don't follow redirects — we just want to verify the route exists
        resp = client.get(
            "/v1/auth/users/oauth/github/authorize",
            headers={"apikey": "pqdb_anon_dummykeyvalue12345678901"},
            follow_redirects=False,
        )
        assert resp.status_code != 404

    def test_callback_route_exists(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/github/callback",
            headers={"apikey": "pqdb_anon_dummykeyvalue12345678901"},
        )
        assert resp.status_code != 404


class TestGitHubAuthorize:
    """Tests for GET /v1/auth/users/oauth/github/authorize."""

    def test_authorize_redirects_to_github(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/github/authorize",
            follow_redirects=False,
        )
        assert resp.status_code == 302
        location = resp.headers["location"]
        assert "github.com/login/oauth/authorize" in location
        assert "test-github-client-id" in location
        assert "state=" in location

    def test_authorize_returns_400_when_not_configured(
        self, unconfigured_client: TestClient
    ) -> None:
        resp = unconfigured_client.get(
            "/v1/auth/users/oauth/github/authorize",
            follow_redirects=False,
        )
        assert resp.status_code == 400
        assert "not configured" in resp.json()["detail"]


class TestGitHubCallback:
    """Tests for GET /v1/auth/users/oauth/github/callback."""

    def _get_valid_state(
        self,
        client: TestClient,
        project_id: uuid.UUID,
        jwt_keys: tuple[Ed25519PrivateKey, Ed25519PublicKey],
    ) -> str:
        """Generate a valid state JWT for testing."""
        from datetime import UTC, datetime, timedelta

        import jwt as pyjwt

        now = datetime.now(UTC)
        payload = {
            "type": "oauth_state",
            "project_id": str(project_id),
            "provider": "github",
            "iat": now,
            "exp": now + timedelta(minutes=10),
            "jti": str(uuid.uuid4()),
        }
        return pyjwt.encode(payload, jwt_keys[0], algorithm="EdDSA")

    def test_callback_missing_code_returns_400(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/github/callback?state=invalid",
        )
        assert resp.status_code == 400

    def test_callback_missing_state_returns_400(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/github/callback?code=test",
        )
        assert resp.status_code == 400

    def test_callback_invalid_state_returns_400(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/github/callback?code=test&state=invalid",
        )
        assert resp.status_code == 400

    def test_callback_github_error_returns_400(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/auth/users/oauth/github/callback?error=access_denied",
        )
        assert resp.status_code == 400
        assert "access_denied" in resp.json()["detail"]

    def test_callback_creates_new_user(
        self,
        client: TestClient,
        project_id: uuid.UUID,
        jwt_keys: tuple[Ed25519PrivateKey, Ed25519PublicKey],
    ) -> None:
        """Full flow: callback creates a new user and returns JWT tokens."""
        state = self._get_valid_state(client, project_id, jwt_keys)

        mock_tokens = OAuthTokens(
            access_token="gho_test_access",
            refresh_token=None,
            expires_in=0,
            token_type="bearer",
        )
        mock_user_info = OAuthUserInfo(
            email="githubuser@example.com",
            name="GitHub User",
            avatar_url="https://avatars.githubusercontent.com/u/1",
            provider_uid="github-uid-123",
        )

        with (
            patch.object(
                GitHubOAuthProvider,
                "exchange_code",
                new_callable=AsyncMock,
                return_value=mock_tokens,
            ),
            patch.object(
                GitHubOAuthProvider,
                "get_user_info",
                new_callable=AsyncMock,
                return_value=mock_user_info,
            ),
        ):
            resp = client.get(
                f"/v1/auth/users/oauth/github/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert resp.status_code == 302
        location = resp.headers["location"]
        assert "access_token=" in location
        assert "refresh_token=" in location
        assert "token_type=bearer" in location

    def test_callback_links_existing_user_by_email(
        self,
        client: TestClient,
        project_id: uuid.UUID,
        jwt_keys: tuple[Ed25519PrivateKey, Ed25519PublicKey],
    ) -> None:
        """When a user with the same email exists, link the OAuth identity."""
        # First, create a user via signup
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "existing@example.com", "password": "testpass123"},
        )
        assert signup_resp.status_code == 201
        original_user_id = signup_resp.json()["user"]["id"]

        state = self._get_valid_state(client, project_id, jwt_keys)

        mock_tokens = OAuthTokens(
            access_token="gho_test_access",
            refresh_token=None,
            expires_in=0,
            token_type="bearer",
        )
        mock_user_info = OAuthUserInfo(
            email="existing@example.com",
            name="Existing User",
            avatar_url=None,
            provider_uid="github-uid-456",
        )

        with (
            patch.object(
                GitHubOAuthProvider,
                "exchange_code",
                new_callable=AsyncMock,
                return_value=mock_tokens,
            ),
            patch.object(
                GitHubOAuthProvider,
                "get_user_info",
                new_callable=AsyncMock,
                return_value=mock_user_info,
            ),
        ):
            resp = client.get(
                f"/v1/auth/users/oauth/github/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert resp.status_code == 302
        location = resp.headers["location"]
        assert "access_token=" in location

        # Decode the access token to verify it's the same user
        import jwt as pyjwt

        fragment = location.split("#")[1]
        params = dict(p.split("=") for p in fragment.split("&"))
        payload = pyjwt.decode(
            params["access_token"],
            jwt_keys[1],
            algorithms=["EdDSA"],
        )
        assert payload["sub"] == original_user_id

    def test_callback_returns_same_user_on_repeat_login(
        self,
        client: TestClient,
        project_id: uuid.UUID,
        jwt_keys: tuple[Ed25519PrivateKey, Ed25519PublicKey],
    ) -> None:
        """Second OAuth login for same provider_uid returns same user."""
        mock_tokens = OAuthTokens(
            access_token="gho_test_access",
            refresh_token=None,
            expires_in=0,
            token_type="bearer",
        )
        mock_user_info = OAuthUserInfo(
            email="repeat@example.com",
            name="Repeat User",
            avatar_url=None,
            provider_uid="github-uid-repeat",
        )

        user_ids = []
        for _ in range(2):
            state = self._get_valid_state(client, project_id, jwt_keys)
            with (
                patch.object(
                    GitHubOAuthProvider,
                    "exchange_code",
                    new_callable=AsyncMock,
                    return_value=mock_tokens,
                ),
                patch.object(
                    GitHubOAuthProvider,
                    "get_user_info",
                    new_callable=AsyncMock,
                    return_value=mock_user_info,
                ),
            ):
                resp = client.get(
                    f"/v1/auth/users/oauth/github/callback?code=test-code&state={state}",
                    follow_redirects=False,
                )
            assert resp.status_code == 302
            location = resp.headers["location"]
            import jwt as pyjwt

            fragment = location.split("#")[1]
            params = dict(p.split("=") for p in fragment.split("&"))
            payload = pyjwt.decode(
                params["access_token"],
                jwt_keys[1],
                algorithms=["EdDSA"],
            )
            user_ids.append(payload["sub"])

        # Same user both times
        assert user_ids[0] == user_ids[1]


class TestHealthCheck:
    """Health check still works with GitHub OAuth routes."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
