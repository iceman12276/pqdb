"""Integration tests for project-scoped request routing (US-009).

Boots the real FastAPI app with an in-process SQLite database,
exercises API key middleware validation and project context resolution.
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

from pqdb_api.config import Settings
from pqdb_api.database import get_session
from pqdb_api.models.base import Base
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.db import router as db_router
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

    settings = Settings(
        database_url="sqlite+aiosqlite://",
        superuser_dsn="postgresql://test:test@localhost/test",
    )

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
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    app.include_router(db_router)
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


def _create_project_and_get_keys(
    client: TestClient, token: str, name: str = "test-project"
) -> tuple[str, list[dict[str, str]]]:
    """Create a project and return (project_id, api_keys)."""
    resp = client.post(
        "/v1/projects",
        json={"name": name},
        headers=_auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    return data["id"], data["api_keys"]


class TestDbHealthRouteExists:
    """Verify /v1/db/health route is registered."""

    def test_db_health_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.status_code != 404


class TestApiKeyMissing:
    """Missing apikey header returns 401."""

    def test_missing_apikey_returns_401(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.status_code == 401

    def test_missing_apikey_error_message(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.json()["detail"] == "Missing apikey header"


class TestApiKeyInvalid:
    """Invalid apikey header returns 403."""

    def test_malformed_key_returns_403(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/db/health",
            headers={"apikey": "not_a_valid_key"},
        )
        assert resp.status_code == 403

    def test_nonexistent_key_returns_403(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/db/health",
            headers={"apikey": "pqdb_anon_aaaabbbbccccddddeeeeffffggg0"},
        )
        assert resp.status_code == 403

    def test_wrong_key_value_returns_403(self, client: TestClient) -> None:
        """Valid format but no matching hash in the database."""
        token = _signup_and_get_token(client, email="wrong@test.com")
        _create_project_and_get_keys(client, token, name="wrong-key-project")
        resp = client.get(
            "/v1/db/health",
            headers={"apikey": "pqdb_anon_aaaabbbbccccddddeeeeffffggg0"},
        )
        assert resp.status_code == 403


class TestApiKeyValid:
    """Valid apikey resolves project context."""

    def test_valid_anon_key_returns_200(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="anon@test.com")
        project_id, keys = _create_project_and_get_keys(client, token, name="anon-proj")
        anon_key = next(k["key"] for k in keys if k["role"] == "anon")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": anon_key},
        )
        assert resp.status_code == 200

    def test_valid_service_key_returns_200(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="svc@test.com")
        project_id, keys = _create_project_and_get_keys(client, token, name="svc-proj")
        svc_key = next(k["key"] for k in keys if k["role"] == "service")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 200

    def test_response_contains_project_id(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="pid@test.com")
        project_id, keys = _create_project_and_get_keys(client, token, name="pid-proj")
        anon_key = next(k["key"] for k in keys if k["role"] == "anon")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": anon_key},
        )
        data = resp.json()
        assert data["project_id"] == project_id

    def test_response_contains_role(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="role@test.com")
        _project_id, keys = _create_project_and_get_keys(
            client, token, name="role-proj"
        )
        anon_key = next(k["key"] for k in keys if k["role"] == "anon")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": anon_key},
        )
        data = resp.json()
        assert data["role"] == "anon"

    def test_service_role_reflected_in_response(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="svcr@test.com")
        _project_id, keys = _create_project_and_get_keys(
            client, token, name="svcr-proj"
        )
        svc_key = next(k["key"] for k in keys if k["role"] == "service")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": svc_key},
        )
        data = resp.json()
        assert data["role"] == "service"


class TestProjectIsolation:
    """Different API keys route to different projects."""

    def test_different_projects_return_different_ids(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="iso@test.com")
        pid_a, keys_a = _create_project_and_get_keys(client, token, name="proj-a")
        pid_b, keys_b = _create_project_and_get_keys(client, token, name="proj-b")

        key_a = next(k["key"] for k in keys_a if k["role"] == "anon")
        key_b = next(k["key"] for k in keys_b if k["role"] == "anon")

        resp_a = client.get("/v1/db/health", headers={"apikey": key_a})
        resp_b = client.get("/v1/db/health", headers={"apikey": key_b})

        assert resp_a.json()["project_id"] == pid_a
        assert resp_b.json()["project_id"] == pid_b
        assert pid_a != pid_b


class TestRotatedKeysWork:
    """After key rotation, old keys are invalid and new keys work."""

    def test_rotated_key_works(self, client: TestClient) -> None:
        token = _signup_and_get_token(client, email="rot@test.com")
        project_id, old_keys = _create_project_and_get_keys(
            client, token, name="rot-proj"
        )
        old_anon = next(k["key"] for k in old_keys if k["role"] == "anon")

        # Rotate
        rotate_resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=_auth_headers(token),
        )
        assert rotate_resp.status_code == 200
        new_keys = rotate_resp.json()
        new_anon = next(k["key"] for k in new_keys if k["role"] == "anon")

        # Old key should fail
        resp_old = client.get("/v1/db/health", headers={"apikey": old_anon})
        assert resp_old.status_code == 403

        # New key should work
        resp_new = client.get("/v1/db/health", headers={"apikey": new_anon})
        assert resp_new.status_code == 200
        assert resp_new.json()["project_id"] == project_id


class TestPlatformHealthUnaffected:
    """Platform health check still works with db routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
