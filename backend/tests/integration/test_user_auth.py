"""Integration tests for end-user auth endpoints (US-025).

Boots the real FastAPI app with real Postgres, tests the full flow:
signup → login → refresh → me → update me → logout → refresh-rejected.

All endpoints use apikey header for project resolution.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

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
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _make_user_auth_app(test_db_url: str, test_db_name: str) -> FastAPI:
    """Build a test FastAPI app for user auth integration tests.

    The project session override points at the same test database,
    and the project context is faked to avoid needing real API keys.
    """
    private_key, public_key = generate_ed25519_keypair()

    # Mock provisioner — returns test DB name
    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return test_db_name

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    # Mock vault
    stored_keys: dict[str, bytes] = {}
    mock_vault = MagicMock(spec=VaultClient)

    def _mock_store(project_id: uuid.UUID, key: bytes) -> None:
        stored_keys[str(project_id)] = key

    def _mock_get(project_id: uuid.UUID) -> bytes:
        key = stored_keys.get(str(project_id))
        if key is None:
            from pqdb_api.services.vault import VaultError

            raise VaultError("Key not found")
        return key

    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store)
    mock_vault.get_hmac_key = MagicMock(side_effect=_mock_get)

    settings = Settings(
        database_url=test_db_url,
        superuser_dsn="postgresql://test:test@localhost/test",
    )

    # Stable project_id for all tests in this module
    fake_project_id = uuid.uuid4()
    fake_context = ProjectContext(
        project_id=fake_project_id,
        key_role="anon",
        database_name=test_db_name,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Platform engine for developer auth / project creation
        platform_engine = create_async_engine(test_db_url)
        platform_factory = async_sessionmaker(
            platform_engine, class_=AsyncSession, expire_on_commit=False
        )

        # Project engine — same DB for tests
        project_engine = create_async_engine(test_db_url)
        project_factory = async_sessionmaker(
            project_engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with platform_factory() as session:
                yield session

        async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
            async with project_factory() as session:
                yield session

        async def _override_get_project_context() -> ProjectContext:
            return fake_context

        app.dependency_overrides[get_session] = _override_get_session
        app.dependency_overrides[get_project_session] = _override_get_project_session
        app.dependency_overrides[get_project_context] = _override_get_project_context
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        app.state.settings = settings
        yield
        await platform_engine.dispose()
        await project_engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    # Register user_auth BEFORE auth to prevent path conflicts
    app.include_router(health_router)
    app.include_router(user_auth_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    return app


@pytest.fixture()
def client(test_db_url: str, test_db_name: str) -> Iterator[TestClient]:
    app = _make_user_auth_app(test_db_url, test_db_name)
    with TestClient(app) as c:
        yield c


class TestUserAuthRoutesExist:
    """Verify all user auth routes are registered and don't 404."""

    def test_signup_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "route@test.com", "password": "testpass123"},
        )
        assert resp.status_code != 404

    def test_login_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/login",
            json={"email": "route@test.com", "password": "testpass123"},
        )
        assert resp.status_code != 404

    def test_logout_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/logout",
            json={"refresh_token": "fake"},
        )
        assert resp.status_code != 404

    def test_refresh_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": "fake"},
        )
        assert resp.status_code != 404

    def test_me_get_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/auth/users/me")
        assert resp.status_code != 404

    def test_me_put_route_exists(self, client: TestClient) -> None:
        resp = client.put(
            "/v1/auth/users/me",
            json={"metadata": {}},
        )
        assert resp.status_code != 404


class TestUserSignup:
    """Tests for POST /v1/auth/users/signup."""

    def test_signup_success(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "user@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"
        assert data["user"]["email"] == "user@example.com"
        assert data["user"]["role"] == "authenticated"
        assert data["user"]["email_verified"] is False
        assert data["user"]["metadata"] == {}

    def test_signup_duplicate_email_returns_409(self, client: TestClient) -> None:
        client.post(
            "/v1/auth/users/signup",
            json={"email": "dup@example.com", "password": "securepass123"},
        )
        resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "dup@example.com", "password": "anotherpass123"},
        )
        assert resp.status_code == 409

    def test_signup_password_too_short_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "short@example.com", "password": "12345"},
        )
        assert resp.status_code == 400
        assert "at least" in resp.json()["detail"]

    def test_signup_invalid_email_returns_422(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "not-an-email", "password": "securepass123"},
        )
        assert resp.status_code == 422


class TestUserLogin:
    """Tests for POST /v1/auth/users/login."""

    def test_login_success(self, client: TestClient) -> None:
        # Signup first
        client.post(
            "/v1/auth/users/signup",
            json={"email": "login@example.com", "password": "securepass123"},
        )
        # Login
        resp = client.post(
            "/v1/auth/users/login",
            json={"email": "login@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["user"]["email"] == "login@example.com"

    def test_login_wrong_password_returns_401(self, client: TestClient) -> None:
        client.post(
            "/v1/auth/users/signup",
            json={"email": "wrongpw@example.com", "password": "securepass123"},
        )
        resp = client.post(
            "/v1/auth/users/login",
            json={"email": "wrongpw@example.com", "password": "wrongpass"},
        )
        assert resp.status_code == 401

    def test_login_nonexistent_user_returns_401(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/login",
            json={"email": "nonexistent@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 401


class TestUserRefresh:
    """Tests for POST /v1/auth/users/refresh."""

    def test_refresh_returns_new_access_token(self, client: TestClient) -> None:
        # Signup
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "refresh@example.com", "password": "securepass123"},
        )
        refresh_token = signup_resp.json()["refresh_token"]

        # Refresh
        resp = client.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": refresh_token},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_refresh_with_invalid_token_returns_401(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": "invalid.token.here"},
        )
        assert resp.status_code == 401


class TestUserLogout:
    """Tests for POST /v1/auth/users/logout."""

    def test_logout_revokes_refresh_token(self, client: TestClient) -> None:
        # Signup
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "logout@example.com", "password": "securepass123"},
        )
        refresh_token = signup_resp.json()["refresh_token"]

        # Logout
        resp = client.post(
            "/v1/auth/users/logout",
            json={"refresh_token": refresh_token},
        )
        assert resp.status_code == 200

    def test_refresh_after_logout_returns_401(self, client: TestClient) -> None:
        """Full flow: signup → logout → refresh should fail."""
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "logoutflow@example.com", "password": "securepass123"},
        )
        refresh_token = signup_resp.json()["refresh_token"]

        # Logout
        client.post(
            "/v1/auth/users/logout",
            json={"refresh_token": refresh_token},
        )

        # Refresh should fail
        resp = client.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": refresh_token},
        )
        assert resp.status_code == 401


class TestUserMe:
    """Tests for GET/PUT /v1/auth/users/me."""

    def test_get_me_returns_profile(self, client: TestClient) -> None:
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "me@example.com", "password": "securepass123"},
        )
        access_token = signup_resp.json()["access_token"]

        resp = client.get(
            "/v1/auth/users/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "me@example.com"
        assert data["role"] == "authenticated"

    def test_get_me_without_token_returns_401(self, client: TestClient) -> None:
        resp = client.get("/v1/auth/users/me")
        assert resp.status_code == 401

    def test_put_me_updates_metadata(self, client: TestClient) -> None:
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "update@example.com", "password": "securepass123"},
        )
        access_token = signup_resp.json()["access_token"]

        resp = client.put(
            "/v1/auth/users/me",
            json={"metadata": {"display_name": "Test User", "age": 25}},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["metadata"]["display_name"] == "Test User"
        assert data["metadata"]["age"] == 25

    def test_updated_metadata_persists(self, client: TestClient) -> None:
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "persist@example.com", "password": "securepass123"},
        )
        access_token = signup_resp.json()["access_token"]

        # Update
        client.put(
            "/v1/auth/users/me",
            json={"metadata": {"key": "value"}},
            headers={"Authorization": f"Bearer {access_token}"},
        )

        # Read back
        resp = client.get(
            "/v1/auth/users/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert resp.json()["metadata"]["key"] == "value"


class TestFullUserAuthFlow:
    """End-to-end flow: signup → login → refresh → me → logout → refresh rejected."""

    def test_full_flow(self, client: TestClient) -> None:
        email = "fullflow@example.com"
        password = "securepass123"

        # 1. Signup
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": email, "password": password},
        )
        assert signup_resp.status_code == 201
        signup_data = signup_resp.json()
        assert signup_data["user"]["email"] == email
        user_id = signup_data["user"]["id"]

        # 2. Login
        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": password},
        )
        assert login_resp.status_code == 200
        login_data = login_resp.json()
        refresh_token = login_data["refresh_token"]
        assert login_data["user"]["id"] == user_id

        # 3. Refresh
        refresh_resp = client.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": refresh_token},
        )
        assert refresh_resp.status_code == 200
        new_access = refresh_resp.json()["access_token"]

        # 4. Get me (with new access token)
        me_resp = client.get(
            "/v1/auth/users/me",
            headers={"Authorization": f"Bearer {new_access}"},
        )
        assert me_resp.status_code == 200
        assert me_resp.json()["email"] == email

        # 5. Logout (revoke the refresh token from login)
        logout_resp = client.post(
            "/v1/auth/users/logout",
            json={"refresh_token": refresh_token},
        )
        assert logout_resp.status_code == 200

        # 6. Refresh should now fail
        rejected_resp = client.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": refresh_token},
        )
        assert rejected_resp.status_code == 401


class TestRateLimiting:
    """Tests for rate limiting on signup and login."""

    def test_signup_rate_limit_after_10_requests(self, client: TestClient) -> None:
        for i in range(10):
            client.post(
                "/v1/auth/users/signup",
                json={"email": f"rate{i}@example.com", "password": "securepass123"},
            )
        # 11th request should be rate limited
        resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "rate10@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 429

    def test_login_rate_limit_after_20_requests(self, client: TestClient) -> None:
        # Signup one user first
        client.post(
            "/v1/auth/users/signup",
            json={"email": "loginrate@example.com", "password": "securepass123"},
        )
        for i in range(20):
            client.post(
                "/v1/auth/users/login",
                json={"email": "loginrate@example.com", "password": "securepass123"},
            )
        # 21st request should be rate limited
        resp = client.post(
            "/v1/auth/users/login",
            json={"email": "loginrate@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 429


class TestHealthCheck:
    """Health check still works with user auth routes."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
