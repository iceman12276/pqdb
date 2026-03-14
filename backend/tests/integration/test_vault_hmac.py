"""Integration tests for Vault HMAC key management.

Boots the real FastAPI app with mocked provisioner and mock VaultClient,
exercises HMAC key storage on project creation and retrieval via endpoint.
"""

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import StaticPool, event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.database import get_session
from pqdb_api.models.base import Base
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _create_test_app(
    vault_keys: dict[str, bytes] | None = None,
) -> FastAPI:
    """Create a test FastAPI app with mock Vault and provisioner."""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, connection_record):  # type: ignore[no-untyped-def]
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    test_session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        async with test_session_factory() as session:
            yield session

    private_key, public_key = generate_ed25519_keypair()

    # Mock provisioner
    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return make_database_name(project_id)

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    # Mock vault client — stores keys in-memory dict
    stored_keys: dict[str, bytes] = vault_keys if vault_keys is not None else {}
    mock_vault = MagicMock(spec=VaultClient)

    def _mock_store(project_id: uuid.UUID, key: bytes) -> None:
        stored_keys[str(project_id)] = key

    def _mock_get(project_id: uuid.UUID) -> bytes:
        key = stored_keys.get(str(project_id))
        if key is None:
            from pqdb_api.services.vault import VaultError

            raise VaultError("Key not found")
        return key

    def _mock_delete(project_id: uuid.UUID) -> None:
        stored_keys.pop(str(project_id), None)

    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store)
    mock_vault.get_hmac_key = MagicMock(side_effect=_mock_get)
    mock_vault.delete_hmac_key = MagicMock(side_effect=_mock_delete)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.dependency_overrides[get_session] = _override_get_session
    return app


def _signup_and_get_token(client: TestClient, email: str = "dev@test.com") -> str:
    resp = client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "testpass123"},
    )
    assert resp.status_code == 201
    token: str = resp.json()["access_token"]
    return token


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = _create_test_app()
    with TestClient(app) as c:
        yield c


class TestHmacKeyRouteExists:
    """Verify the HMAC key endpoint is registered."""

    def test_hmac_key_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/hmac-key")
        assert resp.status_code != 404


class TestHmacKeyAuth:
    """HMAC key endpoint requires valid JWT."""

    def test_hmac_key_without_auth_returns_401_or_403(
        self, client: TestClient
    ) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/hmac-key")
        assert resp.status_code in (401, 403)


class TestHmacKeyStoredOnProjectCreation:
    """HMAC key is generated and stored in Vault when a project is created."""

    def test_create_project_stores_hmac_key(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "hmac-project"},
            headers=_auth_headers(token),
        )
        assert resp.status_code == 201
        project_id = resp.json()["id"]

        # HMAC key should be retrievable
        hmac_resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=_auth_headers(token),
        )
        assert hmac_resp.status_code == 200
        data = hmac_resp.json()
        assert "hmac_key" in data
        # Key should be 256-bit (32 bytes = 64 hex chars)
        assert len(data["hmac_key"]) == 64


class TestGetHmacKey:
    """Tests for GET /v1/projects/{id}/hmac-key."""

    def test_get_hmac_key_returns_key(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "key-project"},
            headers=_auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "hmac_key" in data
        assert isinstance(data["hmac_key"], str)

    def test_get_hmac_key_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = _signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}/hmac-key",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 404

    def test_get_hmac_key_other_developer_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = _signup_and_get_token(client, email="owner@test.com")
        token_b = _signup_and_get_token(client, email="intruder@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "private-hmac"},
            headers=_auth_headers(token_a),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=_auth_headers(token_b),
        )
        assert resp.status_code == 404

    def test_get_hmac_key_consistent_across_requests(
        self, client: TestClient
    ) -> None:
        token = _signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "consistent-key"},
            headers=_auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp1 = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=_auth_headers(token),
        )
        resp2 = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=_auth_headers(token),
        )
        assert resp1.json()["hmac_key"] == resp2.json()["hmac_key"]


class TestHmacKeyRateLimiting:
    """HMAC key endpoint is rate-limited per project."""

    def test_rate_limit_returns_429(self) -> None:
        """After 10 requests, the 11th should return 429."""
        # Use a low-limit rate limiter
        app = _create_test_app()
        with TestClient(app) as client:
            token = _signup_and_get_token(client)
            create_resp = client.post(
                "/v1/projects",
                json={"name": "rate-limit-project"},
                headers=_auth_headers(token),
            )
            project_id = create_resp.json()["id"]

            # Override rate limiter with a very low limit
            app.state.hmac_rate_limiter = RateLimiter(
                max_requests=2, window_seconds=60
            )

            # First 2 should succeed
            for _ in range(2):
                resp = client.get(
                    f"/v1/projects/{project_id}/hmac-key",
                    headers=_auth_headers(token),
                )
                assert resp.status_code == 200

            # 3rd should be rate limited
            resp = client.get(
                f"/v1/projects/{project_id}/hmac-key",
                headers=_auth_headers(token),
            )
            assert resp.status_code == 429
