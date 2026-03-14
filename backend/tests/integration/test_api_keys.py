"""Integration tests for API key endpoints.

Boots the real FastAPI app with an in-process SQLite database,
exercises key generation on project creation, listing, and rotation.
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
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _create_test_app() -> FastAPI:
    """Create a test FastAPI app with in-memory SQLite."""
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

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
        mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

        async def _mock_provision(project_id: uuid.UUID) -> str:
            return make_database_name(project_id)

        mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)
        app.state.provisioner = mock_provisioner
        mock_vault = MagicMock(spec=VaultClient)
        mock_vault.store_hmac_key = MagicMock()
        mock_vault.get_hmac_key = MagicMock(return_value=b"\x00" * 32)
        mock_vault.delete_hmac_key = MagicMock()
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    app.dependency_overrides[get_session] = _override_get_session
    return app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = _create_test_app()
    with TestClient(app) as c:
        yield c


def _signup_and_get_token(client: TestClient, email: str = "dev@test.com") -> str:
    """Sign up a developer and return the access token."""
    resp = client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "testpass123"},
    )
    assert resp.status_code == 201
    token: str = resp.json()["access_token"]
    return token


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_project(client: TestClient, token: str, name: str = "test-project") -> dict:  # type: ignore[type-arg]
    """Create a project and return the response JSON."""
    resp = client.post(
        "/v1/projects",
        json={"name": name},
        headers=_auth_headers(token),
    )
    assert resp.status_code == 201
    data: dict = resp.json()  # type: ignore[type-arg]
    return data


class TestApiKeyRoutesExist:
    """Verify all API key routes are registered and return non-404."""

    def test_list_keys_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/keys")
        assert resp.status_code != 404

    def test_rotate_keys_route_exists(self, client: TestClient) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/keys/rotate")
        assert resp.status_code != 404


class TestApiKeyAuth:
    """API key endpoints require valid JWT."""

    def test_list_keys_without_auth_returns_401_or_403(
        self, client: TestClient
    ) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/keys")
        assert resp.status_code in (401, 403)

    def test_rotate_keys_without_auth_returns_401_or_403(
        self, client: TestClient
    ) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/keys/rotate")
        assert resp.status_code in (401, 403)


class TestProjectCreationGeneratesKeys:
    """Creating a project should auto-generate API keys."""

    def test_create_project_returns_api_keys(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "keyed-project"},
            headers=_auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "api_keys" in data
        keys = data["api_keys"]
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}

    def test_created_keys_have_correct_format(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "format-project"},
            headers=_auth_headers(token),
        )
        data = resp.json()
        for key_info in data["api_keys"]:
            full_key = key_info["key"]
            assert full_key.startswith(f"pqdb_{key_info['role']}_")
            parts = full_key.split("_", 2)
            assert len(parts[2]) == 32

    def test_created_keys_show_prefix(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "prefix-project"},
            headers=_auth_headers(token),
        )
        data = resp.json()
        for key_info in data["api_keys"]:
            assert "key_prefix" in key_info
            assert len(key_info["key_prefix"]) == 8


class TestListKeys:
    """Tests for GET /v1/projects/{project_id}/keys."""

    def test_list_keys_for_project(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        project = _create_project(client, token)
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 200
        keys = resp.json()
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}

    def test_list_keys_does_not_expose_full_key(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        project = _create_project(client, token)
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=_auth_headers(token),
        )
        keys = resp.json()
        for key in keys:
            assert "key" not in key
            assert "key_hash" not in key
            assert "key_prefix" in key

    def test_list_keys_for_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = _signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}/keys",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 404

    def test_list_keys_for_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = _signup_and_get_token(client, email="keya@test.com")
        token_b = _signup_and_get_token(client, email="keyb@test.com")

        project = _create_project(client, token_a, name="private-keys")
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=_auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestRotateKeys:
    """Tests for POST /v1/projects/{project_id}/keys/rotate."""

    def test_rotate_keys_returns_new_keys(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        project = _create_project(client, token)
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 200
        keys = resp.json()
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}
        for key_info in keys:
            assert "key" in key_info
            assert key_info["key"].startswith(f"pqdb_{key_info['role']}_")

    def test_rotate_keys_invalidates_old_keys(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        project = _create_project(client, token)
        project_id = project["id"]

        list_resp1 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=_auth_headers(token),
        )
        old_ids = {k["id"] for k in list_resp1.json()}

        client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=_auth_headers(token),
        )

        list_resp2 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=_auth_headers(token),
        )
        new_ids = {k["id"] for k in list_resp2.json()}
        assert old_ids != new_ids

    def test_rotate_keys_for_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/keys/rotate",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 404

    def test_rotate_keys_for_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = _signup_and_get_token(client, email="rota@test.com")
        token_b = _signup_and_get_token(client, email="rotb@test.com")

        project = _create_project(client, token_a, name="rotate-private")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=_auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestHealthCheck:
    """Health check still works with API key routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200


class TestFullApiKeyFlow:
    """End-to-end: signup -> create -> list keys -> rotate."""

    def test_complete_api_key_flow(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="flow@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "flow-project"},
            headers=_auth_headers(token),
        )
        assert create_resp.status_code == 201
        project = create_resp.json()
        project_id = project["id"]

        assert len(project["api_keys"]) == 2
        original_keys = {k["key"] for k in project["api_keys"]}
        assert len(original_keys) == 2

        list_resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=_auth_headers(token),
        )
        assert list_resp.status_code == 200
        listed_keys = list_resp.json()
        assert len(listed_keys) == 2
        for k in listed_keys:
            assert "key" not in k
            assert "key_prefix" in k

        rotate_resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=_auth_headers(token),
        )
        assert rotate_resp.status_code == 200
        new_keys = {k["key"] for k in rotate_resp.json()}
        assert len(new_keys) == 2
        assert new_keys != original_keys

        list_resp2 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=_auth_headers(token),
        )
        assert len(list_resp2.json()) == 2
