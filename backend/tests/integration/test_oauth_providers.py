"""Integration tests for OAuth provider CRUD endpoints.

Boots the real FastAPI app with real Postgres, tests:
- POST /v1/projects/{id}/auth/providers — configure provider
- GET /v1/projects/{id}/auth/providers — list providers
- DELETE /v1/projects/{id}/auth/providers/{name} — remove provider
- Full lifecycle: configure → list → delete → list empty
- Vault credential storage (mocked but integration-tested)
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

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
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.oauth_providers import router as oauth_providers_router
from pqdb_api.routes.projects import router as projects_router
from tests.integration.conftest import (
    auth_headers,
    create_project,
    signup_and_get_token,
)


def _make_oauth_app(test_db_url: str) -> FastAPI:
    """Build a test app with OAuth provider routes backed by real Postgres."""
    from unittest.mock import AsyncMock, MagicMock

    from pqdb_api.config import Settings
    from pqdb_api.routes.api_keys import router as api_keys_router
    from pqdb_api.services.auth import generate_mldsa65_keypair
    from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
    from pqdb_api.services.rate_limiter import RateLimiter
    from pqdb_api.services.vault import VaultClient

    private_key, public_key = generate_mldsa65_keypair()

    # Mock provisioner
    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return make_database_name(project_id)

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    # Mock vault with in-memory OAuth credential store
    stored_hmac_keys: dict[str, bytes] = {}
    oauth_store: dict[str, dict[str, dict[str, str]]] = {}  # pid -> provider -> creds

    mock_vault = MagicMock(spec=VaultClient)

    def _mock_store_hmac(project_id: uuid.UUID, key: bytes) -> None:
        stored_hmac_keys[str(project_id)] = key

    def _mock_store_oauth(
        project_id: uuid.UUID, provider: str, credentials: dict[str, Any]
    ) -> None:
        pid = str(project_id)
        if pid not in oauth_store:
            oauth_store[pid] = {}
        oauth_store[pid][provider] = credentials

    def _mock_get_oauth(project_id: uuid.UUID, provider: str) -> dict[str, Any]:
        pid = str(project_id)
        if pid not in oauth_store or provider not in oauth_store[pid]:
            from pqdb_api.services.vault import VaultError

            raise VaultError("Not found")
        return oauth_store[pid][provider]

    def _mock_delete_oauth(project_id: uuid.UUID, provider: str) -> None:
        pid = str(project_id)
        if pid in oauth_store:
            oauth_store[pid].pop(provider, None)

    def _mock_list_providers(project_id: uuid.UUID) -> list[str]:
        pid = str(project_id)
        return list(oauth_store.get(pid, {}).keys())

    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store_hmac)
    mock_vault.store_oauth_credentials = MagicMock(side_effect=_mock_store_oauth)
    mock_vault.get_oauth_credentials = MagicMock(side_effect=_mock_get_oauth)
    mock_vault.delete_oauth_credentials = MagicMock(side_effect=_mock_delete_oauth)
    mock_vault.list_oauth_providers = MagicMock(side_effect=_mock_list_providers)

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
        app.state.mldsa65_private_key = private_key
        app.state.mldsa65_public_key = public_key
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
    app.include_router(oauth_providers_router)
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_oauth_app(test_db_url)
    with TestClient(app) as c:
        yield c


class TestOAuthProviderRoutesExist:
    """Verify OAuth provider routes are registered and return non-404."""

    def test_post_providers_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/auth/providers",
            json={
                "provider": "google",
                "client_id": "x",
                "client_secret": "y",
            },
        )
        assert resp.status_code != 404

    def test_get_providers_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/auth/providers")
        assert resp.status_code != 404

    def test_delete_provider_route_exists(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}/auth/providers/google")
        assert resp.status_code != 404


class TestOAuthProviderAuth:
    """OAuth provider endpoints require valid JWT."""

    def test_post_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/auth/providers",
            json={
                "provider": "google",
                "client_id": "x",
                "client_secret": "y",
            },
        )
        assert resp.status_code in (401, 403)

    def test_get_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/auth/providers")
        assert resp.status_code in (401, 403)

    def test_delete_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}/auth/providers/google")
        assert resp.status_code in (401, 403)


class TestConfigureProvider:
    """Tests for POST /v1/projects/{id}/auth/providers."""

    def test_configure_google_provider(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.post(
            f"/v1/projects/{project['id']}/auth/providers",
            json={
                "provider": "google",
                "client_id": "google-client-id",
                "client_secret": "google-client-secret",
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["provider"] == "google"
        assert data["status"] == "configured"

    def test_configure_github_provider(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.post(
            f"/v1/projects/{project['id']}/auth/providers",
            json={
                "provider": "github",
                "client_id": "github-client-id",
                "client_secret": "github-client-secret",
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        assert resp.json()["provider"] == "github"

    def test_configure_unsupported_provider_returns_400(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.post(
            f"/v1/projects/{project['id']}/auth/providers",
            json={
                "provider": "facebook",
                "client_id": "x",
                "client_secret": "y",
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 400
        assert "Unsupported provider" in resp.json()["detail"]

    def test_configure_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/auth/providers",
            json={
                "provider": "google",
                "client_id": "x",
                "client_secret": "y",
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestListProviders:
    """Tests for GET /v1/projects/{id}/auth/providers."""

    def test_list_empty_when_none_configured(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.get(
            f"/v1/projects/{project['id']}/auth/providers",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["providers"] == []

    def test_list_shows_configured_providers(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        pid = project["id"]

        # Configure google
        client.post(
            f"/v1/projects/{pid}/auth/providers",
            json={
                "provider": "google",
                "client_id": "gid",
                "client_secret": "gsecret",
            },
            headers=auth_headers(token),
        )

        resp = client.get(
            f"/v1/projects/{pid}/auth/providers",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert "google" in resp.json()["providers"]

    def test_list_nonexistent_project_returns_404(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}/auth/providers",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestDeleteProvider:
    """Tests for DELETE /v1/projects/{id}/auth/providers/{name}."""

    def test_delete_configured_provider(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        pid = project["id"]

        # Configure
        client.post(
            f"/v1/projects/{pid}/auth/providers",
            json={
                "provider": "google",
                "client_id": "gid",
                "client_secret": "gsecret",
            },
            headers=auth_headers(token),
        )

        # Delete
        resp = client.delete(
            f"/v1/projects/{pid}/auth/providers/google",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["provider"] == "google"
        assert resp.json()["status"] == "deleted"

    def test_delete_nonexistent_project_returns_404(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.delete(
            f"/v1/projects/{uuid.uuid4()}/auth/providers/google",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestFullLifecycle:
    """End-to-end lifecycle: configure → list → delete → list empty."""

    def test_full_provider_lifecycle(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        pid = project["id"]

        # 1. List — empty
        resp = client.get(
            f"/v1/projects/{pid}/auth/providers",
            headers=auth_headers(token),
        )
        assert resp.json()["providers"] == []

        # 2. Configure google
        resp = client.post(
            f"/v1/projects/{pid}/auth/providers",
            json={
                "provider": "google",
                "client_id": "gid",
                "client_secret": "gsecret",
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 201

        # 3. List — shows google
        resp = client.get(
            f"/v1/projects/{pid}/auth/providers",
            headers=auth_headers(token),
        )
        assert "google" in resp.json()["providers"]

        # 4. Delete google
        resp = client.delete(
            f"/v1/projects/{pid}/auth/providers/google",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200

        # 5. List — empty again
        resp = client.get(
            f"/v1/projects/{pid}/auth/providers",
            headers=auth_headers(token),
        )
        assert resp.json()["providers"] == []


class TestHealthCheck:
    """Health check still works with OAuth provider routes."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
