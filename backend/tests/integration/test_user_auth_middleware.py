"""Integration tests for end-user auth middleware (US-026).

Boots the real FastAPI app with real Postgres. Tests that:
- Valid user JWT → UserContext injected
- Invalid JWT → 401 with structured error
- No JWT → no user context (optional dependency)
- Project ID mismatch → 401
- Expired token → 401
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import APIRouter, Depends, FastAPI
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
from pqdb_api.middleware.user_auth import UserContext, get_current_user
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _make_middleware_test_app(
    test_db_url: str,
    test_db_name: str,
    fake_project_id: uuid.UUID | None = None,
) -> tuple[FastAPI, uuid.UUID]:
    """Build a test app with a diagnostic endpoint that exposes UserContext."""
    private_key, public_key = generate_ed25519_keypair()
    project_id = fake_project_id or uuid.uuid4()

    fake_context = ProjectContext(
        project_id=project_id,
        key_role="anon",
        database_name=test_db_name,
    )

    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"
    mock_provisioner.provision = AsyncMock(return_value=test_db_name)

    mock_vault = MagicMock(spec=VaultClient)
    mock_vault.store_hmac_key = MagicMock()
    mock_vault.get_hmac_key = MagicMock(return_value=b"\x00" * 32)

    settings = Settings(
        database_url=test_db_url,
        superuser_dsn="postgresql://test:test@localhost/test",
    )

    # Diagnostic router — exposes user context info
    diag_router = APIRouter(prefix="/v1/diag", tags=["diag"])

    @diag_router.get("/user-context")
    async def user_context_endpoint(
        user: UserContext | None = Depends(get_current_user),
    ) -> dict[str, Any]:
        if user is None:
            return {"user": None}
        return {
            "user": {
                "user_id": str(user.user_id),
                "project_id": str(user.project_id),
                "role": user.role,
                "email_verified": user.email_verified,
            }
        }

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        platform_engine = create_async_engine(test_db_url)
        platform_factory = async_sessionmaker(
            platform_engine, class_=AsyncSession, expire_on_commit=False
        )
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
        app.state.hmac_rate_limiter = RateLimiter(max_requests=100, window_seconds=60)
        app.state.settings = settings
        yield
        await platform_engine.dispose()
        await project_engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(user_auth_router)
    app.include_router(diag_router)
    return app, project_id


@pytest.fixture()
def project_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture()
def client(
    test_db_url: str, test_db_name: str, project_id: uuid.UUID
) -> Iterator[TestClient]:
    app, _ = _make_middleware_test_app(test_db_url, test_db_name, project_id)
    with TestClient(app) as c:
        yield c


def _signup_user(client: TestClient, email: str = "mw@example.com") -> dict[str, Any]:
    """Sign up a user and return the response JSON."""
    resp = client.post(
        "/v1/auth/users/signup",
        json={"email": email, "password": "securepass123"},
    )
    assert resp.status_code == 201
    data: dict[str, Any] = resp.json()
    return data


class TestGetCurrentUserOptional:
    """Test that get_current_user is optional — no JWT means no user context."""

    def test_no_auth_header_returns_null_user(self, client: TestClient) -> None:
        resp = client.get("/v1/diag/user-context")
        assert resp.status_code == 200
        assert resp.json()["user"] is None

    def test_empty_bearer_returns_null_user(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/diag/user-context",
            headers={"Authorization": "Basic abc"},
        )
        assert resp.status_code == 200
        assert resp.json()["user"] is None


class TestGetCurrentUserValid:
    """Test that valid user JWT → UserContext injected."""

    def test_valid_token_injects_user_context(self, client: TestClient) -> None:
        signup = _signup_user(client)
        access_token = signup["access_token"]

        resp = client.get(
            "/v1/diag/user-context",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["user"] is not None
        assert data["user"]["user_id"] == signup["user"]["id"]
        assert data["user"]["role"] == "authenticated"
        assert data["user"]["email_verified"] is False

    def test_user_context_project_id_matches(
        self, client: TestClient, project_id: uuid.UUID
    ) -> None:
        signup = _signup_user(client, email="projcheck@example.com")
        access_token = signup["access_token"]

        resp = client.get(
            "/v1/diag/user-context",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["user"]["project_id"] == str(project_id)


class TestGetCurrentUserInvalid:
    """Test that invalid JWTs return 401 with structured error."""

    def test_garbage_token_returns_401(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/diag/user-context",
            headers={"Authorization": "Bearer garbage.token.here"},
        )
        assert resp.status_code == 401
        detail = resp.json()["detail"]
        assert detail["error"]["code"] == "user_token_invalid"

    def test_expired_token_returns_401(
        self, client: TestClient, project_id: uuid.UUID
    ) -> None:
        """Create an expired token manually and verify rejection."""
        from datetime import UTC, datetime, timedelta

        import jwt as pyjwt

        from pqdb_api.services.auth import JWT_ALGORITHM

        # Get the app's private key from the test client
        private_key = client.app.state.jwt_private_key  # type: ignore[attr-defined]
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "project_id": str(project_id),
            "type": "user_access",
            "role": "authenticated",
            "email_verified": False,
            "iat": now - timedelta(hours=1),
            "exp": now - timedelta(minutes=30),
        }
        token = pyjwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)

        resp = client.get(
            "/v1/diag/user-context",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401
        detail = resp.json()["detail"]
        assert detail["error"]["code"] == "user_token_invalid"
        assert "expired" in detail["error"]["message"].lower()

    def test_developer_token_rejected(self, client: TestClient) -> None:
        """Developer tokens (type=access) must be rejected."""
        from datetime import UTC, datetime, timedelta

        import jwt as pyjwt

        from pqdb_api.services.auth import JWT_ALGORITHM

        private_key = client.app.state.jwt_private_key  # type: ignore[attr-defined]
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "type": "access",  # developer token
            "iat": now,
            "exp": now + timedelta(minutes=15),
        }
        token = pyjwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)

        resp = client.get(
            "/v1/diag/user-context",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401
        detail = resp.json()["detail"]
        assert detail["error"]["code"] == "user_token_invalid"

    def test_project_id_mismatch_returns_401(self, client: TestClient) -> None:
        """User JWT from project A cannot access project B."""
        from datetime import UTC, datetime, timedelta

        import jwt as pyjwt

        from pqdb_api.services.auth import JWT_ALGORITHM

        private_key = client.app.state.jwt_private_key  # type: ignore[attr-defined]
        now = datetime.now(UTC)
        different_project = uuid.uuid4()
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "project_id": str(different_project),
            "type": "user_access",
            "role": "authenticated",
            "email_verified": False,
            "iat": now,
            "exp": now + timedelta(minutes=15),
        }
        token = pyjwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)

        resp = client.get(
            "/v1/diag/user-context",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401
        detail = resp.json()["detail"]
        assert detail["error"]["code"] == "user_token_invalid"
        assert "project" in detail["error"]["message"].lower()


class TestHealthCheck:
    """Health check still works with user auth middleware."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
