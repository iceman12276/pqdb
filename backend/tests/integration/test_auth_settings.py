"""Integration tests for auth settings endpoints.

Boots the real FastAPI app with real Postgres, tests:
- Auth tables creation in project database
- GET/POST /v1/projects/{id}/auth/settings
- Auth requires developer JWT
- Settings persist across requests
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.auth_settings import router as auth_settings_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from tests.integration.conftest import (
    auth_headers,
    create_project,
    signup_and_get_token,
)


def _make_auth_settings_app(test_db_url: str, test_db_name: str) -> FastAPI:
    """Build a test app with auth_settings routes that use the test DB.

    The mock provisioner returns test_db_name so that the auth settings
    endpoints connect to the same test database (not a non-existent
    project database).
    """
    from unittest.mock import AsyncMock, MagicMock

    from pqdb_api.config import Settings
    from pqdb_api.routes.api_keys import router as api_keys_router
    from pqdb_api.services.auth import generate_ed25519_keypair
    from pqdb_api.services.provisioner import DatabaseProvisioner
    from pqdb_api.services.rate_limiter import RateLimiter
    from pqdb_api.services.vault import VaultClient

    private_key, public_key = generate_ed25519_keypair()

    # Mock provisioner — returns test DB name so project.database_name
    # points to the real test database for auth table creation
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
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        app.state.settings = settings
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    app.include_router(auth_settings_router)
    return app


@pytest.fixture()
def client(test_db_url: str, test_db_name: str) -> Iterator[TestClient]:
    app = _make_auth_settings_app(test_db_url, test_db_name)
    with TestClient(app) as c:
        yield c


class TestAuthSettingsRoutesExist:
    """Verify auth settings routes are registered."""

    def test_get_auth_settings_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/auth/settings")
        assert resp.status_code != 404

    def test_post_auth_settings_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/auth/settings",
            json={},
        )
        assert resp.status_code != 404


class TestAuthSettingsAuth:
    """Auth settings endpoints require valid JWT."""

    def test_get_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/auth/settings")
        assert resp.status_code in (401, 403)

    def test_post_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/auth/settings",
            json={"password_min_length": 12},
        )
        assert resp.status_code in (401, 403)


class TestGetAuthSettings:
    """Tests for GET /v1/projects/{id}/auth/settings."""

    def test_get_settings_for_nonexistent_project(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}/auth/settings",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_get_settings_returns_defaults(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.get(
            f"/v1/projects/{project['id']}/auth/settings",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["require_email_verification"] is False
        assert data["magic_link_webhook"] is None
        assert data["password_min_length"] == 8
        assert data["mfa_enabled"] is False

    def test_get_other_developers_project_returns_404(self, client: TestClient) -> None:
        token_a = signup_and_get_token(client, email="owner-auth@test.com")
        token_b = signup_and_get_token(client, email="intruder-auth@test.com")
        project = create_project(client, token_a)
        resp = client.get(
            f"/v1/projects/{project['id']}/auth/settings",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestUpdateAuthSettings:
    """Tests for POST /v1/projects/{id}/auth/settings."""

    def test_update_single_field(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.post(
            f"/v1/projects/{project['id']}/auth/settings",
            json={"password_min_length": 12},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["password_min_length"] == 12
        # Other fields unchanged
        assert resp.json()["require_email_verification"] is False

    def test_update_multiple_fields(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.post(
            f"/v1/projects/{project['id']}/auth/settings",
            json={
                "require_email_verification": True,
                "mfa_enabled": True,
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["require_email_verification"] is True
        assert data["mfa_enabled"] is True

    def test_update_nonexistent_project(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/auth/settings",
            json={"password_min_length": 12},
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_settings_persist_across_requests(self, client: TestClient) -> None:
        """Updated settings should be returned by subsequent GET."""
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        # Update
        client.post(
            f"/v1/projects/{project_id}/auth/settings",
            json={"password_min_length": 20, "mfa_enabled": True},
            headers=auth_headers(token),
        )

        # Read back
        resp = client.get(
            f"/v1/projects/{project_id}/auth/settings",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["password_min_length"] == 20
        assert data["mfa_enabled"] is True


class TestHealthCheck:
    """Health check still works with auth settings routes."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
