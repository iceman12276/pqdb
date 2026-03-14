"""Integration tests for auth endpoints.

Boots the real FastAPI app with a real Postgres database,
exercises signup -> login -> authenticated request -> refresh flow.
"""

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.services.auth import generate_ed25519_keypair


def _create_test_app(test_db_url: str) -> FastAPI:
    """Create a test FastAPI app with real Postgres.

    Creates its own engine inside the lifespan so it runs on
    the TestClient's event loop.
    """
    private_key, public_key = generate_ed25519_keypair()

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
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(auth_router)

    # Protected test endpoint
    from fastapi import APIRouter

    protected_router = APIRouter()

    @protected_router.get("/v1/protected")
    async def protected_endpoint(
        developer_id: uuid.UUID = Depends(get_current_developer_id),
    ) -> dict[str, str]:
        return {"developer_id": str(developer_id)}

    app.include_router(protected_router)
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _create_test_app(test_db_url)
    with TestClient(app) as c:
        yield c


class TestAuthRoutes:
    """Integration tests for auth routes."""

    def test_auth_routes_exist(self, client: TestClient) -> None:
        # Signup route exists (not 404/405)
        resp = client.post(
            "/v1/auth/signup",
            json={"email": "route@test.com", "password": "testpass123"},
        )
        assert resp.status_code != 404

        # Login route exists
        resp = client.post(
            "/v1/auth/login",
            json={"email": "nonexistent@test.com", "password": "pass"},
        )
        assert resp.status_code != 404

        # Refresh route exists
        resp = client.post("/v1/auth/refresh", json={"refresh_token": "fake"})
        assert resp.status_code != 404


class TestSignup:
    """Tests for POST /v1/auth/signup."""

    def test_signup_success(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/signup",
            json={"email": "new@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"

    def test_signup_duplicate_email_returns_409(self, client: TestClient) -> None:
        payload = {"email": "dup@example.com", "password": "pass123"}
        resp1 = client.post("/v1/auth/signup", json=payload)
        assert resp1.status_code == 201

        resp2 = client.post("/v1/auth/signup", json=payload)
        assert resp2.status_code == 409

    def test_signup_invalid_email_returns_422(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/signup",
            json={"email": "not-an-email", "password": "pass123"},
        )
        assert resp.status_code == 422

    def test_signup_missing_fields_returns_422(self, client: TestClient) -> None:
        resp = client.post("/v1/auth/signup", json={"email": "a@b.com"})
        assert resp.status_code == 422


class TestLogin:
    """Tests for POST /v1/auth/login."""

    def test_login_success(self, client: TestClient) -> None:
        client.post(
            "/v1/auth/signup",
            json={"email": "login@example.com", "password": "mypassword"},
        )
        resp = client.post(
            "/v1/auth/login",
            json={"email": "login@example.com", "password": "mypassword"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data

    def test_login_wrong_password_returns_401(self, client: TestClient) -> None:
        client.post(
            "/v1/auth/signup",
            json={"email": "wrong@example.com", "password": "correct"},
        )
        resp = client.post(
            "/v1/auth/login",
            json={"email": "wrong@example.com", "password": "incorrect"},
        )
        assert resp.status_code == 401

    def test_login_nonexistent_user_returns_401(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/login",
            json={"email": "ghost@example.com", "password": "pass"},
        )
        assert resp.status_code == 401


class TestRefresh:
    """Tests for POST /v1/auth/refresh."""

    def test_refresh_success(self, client: TestClient) -> None:
        signup_resp = client.post(
            "/v1/auth/signup",
            json={"email": "refresh@example.com", "password": "pass123"},
        )
        refresh_token = signup_resp.json()["refresh_token"]

        resp = client.post("/v1/auth/refresh", json={"refresh_token": refresh_token})
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_refresh_invalid_token_returns_401(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/refresh", json={"refresh_token": "invalid.token.here"}
        )
        assert resp.status_code == 401

    def test_refresh_with_access_token_returns_401(self, client: TestClient) -> None:
        signup_resp = client.post(
            "/v1/auth/signup",
            json={"email": "access_as_refresh@example.com", "password": "pass123"},
        )
        access_token = signup_resp.json()["access_token"]

        resp = client.post("/v1/auth/refresh", json={"refresh_token": access_token})
        assert resp.status_code == 401


class TestProtectedEndpoint:
    """Tests for JWT auth middleware on protected endpoints."""

    def test_authenticated_request_succeeds(self, client: TestClient) -> None:
        signup_resp = client.post(
            "/v1/auth/signup",
            json={"email": "authed@example.com", "password": "pass123"},
        )
        token = signup_resp.json()["access_token"]

        resp = client.get(
            "/v1/protected",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert "developer_id" in resp.json()

    def test_missing_token_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get("/v1/protected")
        assert resp.status_code in (401, 403)

    def test_invalid_token_returns_401(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/protected",
            headers={"Authorization": "Bearer invalid.token"},
        )
        assert resp.status_code == 401

    def test_refresh_token_as_access_returns_401(self, client: TestClient) -> None:
        signup_resp = client.post(
            "/v1/auth/signup",
            json={"email": "refresh_as_access@example.com", "password": "pass123"},
        )
        refresh_token = signup_resp.json()["refresh_token"]

        resp = client.get(
            "/v1/protected",
            headers={"Authorization": f"Bearer {refresh_token}"},
        )
        assert resp.status_code == 401


class TestFullAuthFlow:
    """End-to-end auth flow: signup -> login -> authenticated request -> refresh."""

    def test_complete_flow(self, client: TestClient) -> None:
        # 1. Sign up
        signup_resp = client.post(
            "/v1/auth/signup",
            json={"email": "flow@example.com", "password": "flowpass123"},
        )
        assert signup_resp.status_code == 201
        tokens = signup_resp.json()

        # 2. Use access token on protected endpoint
        resp = client.get(
            "/v1/protected",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert resp.status_code == 200
        developer_id = resp.json()["developer_id"]

        # 3. Login with same credentials
        login_resp = client.post(
            "/v1/auth/login",
            json={"email": "flow@example.com", "password": "flowpass123"},
        )
        assert login_resp.status_code == 200

        # 4. Use login token on protected endpoint - same developer
        resp2 = client.get(
            "/v1/protected",
            headers={"Authorization": f"Bearer {login_resp.json()['access_token']}"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["developer_id"] == developer_id

        # 5. Refresh token
        refresh_resp = client.post(
            "/v1/auth/refresh",
            json={"refresh_token": tokens["refresh_token"]},
        )
        assert refresh_resp.status_code == 200

        # 6. Use refreshed token
        resp3 = client.get(
            "/v1/protected",
            headers={"Authorization": f"Bearer {refresh_resp.json()['access_token']}"},
        )
        assert resp3.status_code == 200
        assert resp3.json()["developer_id"] == developer_id
