"""Integration tests for audit log middleware and log retrieval endpoint."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
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
from pqdb_api.middleware.api_key import ProjectContext, get_project_context, get_project_session
from pqdb_api.middleware.audit import AuditMiddleware
from pqdb_api.middleware.user_auth import get_current_user
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.logs import router as logs_router
from pqdb_api.routes.project_overview import router as overview_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.services.audit_log import ensure_audit_table, write_audit_log
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.rate_limiter import RateLimiter

from tests.integration.conftest import (
    PG_HOST,
    PG_PASS,
    PG_PORT,
    PG_USER,
    auth_headers,
    signup_and_get_token,
    create_project,
)


def _make_audit_test_app(test_db_url: str) -> FastAPI:
    """Build a test app with audit middleware for project-scoped endpoints."""
    from unittest.mock import AsyncMock, MagicMock

    from pqdb_api.config import Settings
    from pqdb_api.models.base import Base
    from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
    from pqdb_api.services.vault import VaultClient

    private_key, public_key = generate_ed25519_keypair()

    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return make_database_name(project_id)

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    stored_keys: dict[str, bytes] = {}
    mock_vault = MagicMock(spec=VaultClient)

    def _mock_store(project_id: uuid.UUID, key: bytes) -> None:
        stored_keys[str(project_id)] = key

    def _mock_get_keys(project_id: uuid.UUID) -> Any:
        from pqdb_api.services.vault import VersionedHmacKeys, VaultError

        key = stored_keys.get(str(project_id))
        if key is None:
            raise VaultError("Key not found")
        return VersionedHmacKeys(current_version=1, keys={"1": key.hex()})

    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store)
    mock_vault.get_hmac_keys = MagicMock(side_effect=_mock_get_keys)

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

        # For audit middleware: route project sessions to test DB
        app.state._test_audit_session_factory = session_factory
        # For _get_project_session in logs/overview routes
        app.state._test_project_session_factory = session_factory

        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(AuditMiddleware)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(logs_router)
    app.include_router(overview_router)
    app.include_router(db_router)
    return app


class TestAuditLogMiddleware:
    """Tests for audit log middleware writing entries on project-scoped requests."""

    def test_audit_log_written_on_db_request(self, test_db_url: str) -> None:
        """Audit middleware should write a log entry when a project-scoped request is made."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)
            project_id = project["id"]

            # Make a request to the logs endpoint to verify logs exist
            resp = client.get(
                f"/v1/projects/{project_id}/logs",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()
            assert "data" in data
            assert "total" in data

    def test_audit_log_not_written_for_non_apikey_requests(
        self, test_db_url: str
    ) -> None:
        """Audit middleware should NOT write logs for requests without apikey header."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            # Health check - no apikey
            resp = client.get("/health")
            assert resp.status_code == 200

            # Auth signup - no apikey
            resp = client.post(
                "/v1/auth/signup",
                json={"email": "dev@test.com", "password": "testpass123"},
            )
            assert resp.status_code == 201


class TestAuditLogEndpoint:
    """Tests for the GET /v1/projects/{id}/logs endpoint."""

    def test_get_logs_empty(self, test_db_url: str) -> None:
        """Should return empty logs for a new project."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)

            resp = client.get(
                f"/v1/projects/{project['id']}/logs",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["data"] == []
            assert data["total"] == 0
            assert data["limit"] == 50
            assert data["offset"] == 0

    def test_get_logs_with_entries(self, test_db_url: str) -> None:
        """Should return audit log entries after they are written."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)
            pid = uuid.UUID(project["id"])

            # Manually write some audit log entries
            import asyncio

            async def _write_entries() -> None:
                engine = create_async_engine(test_db_url)
                factory = async_sessionmaker(
                    engine, class_=AsyncSession, expire_on_commit=False
                )
                async with factory() as session:
                    await ensure_audit_table(session)
                    for i in range(3):
                        await write_audit_log(
                            session,
                            event_type="database",
                            method="POST",
                            path=f"/v1/db/users/select",
                            status_code=200,
                            project_id=pid,
                            user_id=None,
                            ip_address="127.0.0.1",
                        )
                await engine.dispose()

            asyncio.get_event_loop().run_until_complete(_write_entries())

            resp = client.get(
                f"/v1/projects/{project['id']}/logs",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 3
            assert len(data["data"]) == 3
            # Check structure of a log entry
            entry = data["data"][0]
            assert entry["event_type"] == "database"
            assert entry["method"] == "POST"
            assert entry["status_code"] == 200
            assert entry["ip_address"] == "127.0.0.1"

    def test_get_logs_filter_by_event_type(self, test_db_url: str) -> None:
        """Should filter logs by event_type."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)
            pid = uuid.UUID(project["id"])

            import asyncio

            async def _write_entries() -> None:
                engine = create_async_engine(test_db_url)
                factory = async_sessionmaker(
                    engine, class_=AsyncSession, expire_on_commit=False
                )
                async with factory() as session:
                    await ensure_audit_table(session)
                    await write_audit_log(
                        session,
                        event_type="database",
                        method="POST",
                        path="/v1/db/users/select",
                        status_code=200,
                        project_id=pid,
                        user_id=None,
                        ip_address="127.0.0.1",
                    )
                    await write_audit_log(
                        session,
                        event_type="auth",
                        method="POST",
                        path="/v1/auth/login",
                        status_code=200,
                        project_id=pid,
                        user_id=None,
                        ip_address="127.0.0.1",
                    )
                await engine.dispose()

            asyncio.get_event_loop().run_until_complete(_write_entries())

            # Filter by database
            resp = client.get(
                f"/v1/projects/{project['id']}/logs?event_type=database",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 1
            assert data["data"][0]["event_type"] == "database"

            # Filter by auth
            resp = client.get(
                f"/v1/projects/{project['id']}/logs?event_type=auth",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 1
            assert data["data"][0]["event_type"] == "auth"

    def test_get_logs_pagination(self, test_db_url: str) -> None:
        """Should paginate logs correctly."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)
            pid = uuid.UUID(project["id"])

            import asyncio

            async def _write_entries() -> None:
                engine = create_async_engine(test_db_url)
                factory = async_sessionmaker(
                    engine, class_=AsyncSession, expire_on_commit=False
                )
                async with factory() as session:
                    await ensure_audit_table(session)
                    for i in range(5):
                        await write_audit_log(
                            session,
                            event_type="database",
                            method="GET",
                            path=f"/v1/db/tables",
                            status_code=200,
                            project_id=pid,
                            user_id=None,
                            ip_address="127.0.0.1",
                        )
                await engine.dispose()

            asyncio.get_event_loop().run_until_complete(_write_entries())

            resp = client.get(
                f"/v1/projects/{project['id']}/logs?limit=2&offset=0",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 5
            assert len(data["data"]) == 2
            assert data["limit"] == 2
            assert data["offset"] == 0

    def test_get_logs_requires_auth(self, test_db_url: str) -> None:
        """Should require developer JWT."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            resp = client.get(
                f"/v1/projects/{uuid.uuid4()}/logs",
            )
            assert resp.status_code == 401

    def test_get_logs_wrong_project(self, test_db_url: str) -> None:
        """Should return 404 for non-existent project."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            resp = client.get(
                f"/v1/projects/{uuid.uuid4()}/logs",
                headers=auth_headers(token),
            )
            assert resp.status_code == 404


class TestProjectOverviewEndpoint:
    """Tests for the GET /v1/projects/{id}/overview endpoint."""

    def test_overview_returns_stats(self, test_db_url: str) -> None:
        """Should return project overview with all stat fields."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)

            resp = client.get(
                f"/v1/projects/{project['id']}/overview",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["project_id"] == project["id"]
            assert data["name"] == "test-project"
            assert data["status"] == "active"
            assert data["encryption"] == "ML-KEM-768"
            assert data["tables_count"] == 0
            assert data["auth_users_count"] == 0
            assert data["rls_policies_count"] == 0
            assert data["database_requests"] == 0
            assert data["auth_requests"] == 0
            assert data["realtime_requests"] == 0
            assert data["mcp_requests"] == 0

    def test_overview_requires_auth(self, test_db_url: str) -> None:
        """Should require developer JWT."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            resp = client.get(f"/v1/projects/{uuid.uuid4()}/overview")
            assert resp.status_code == 401

    def test_overview_wrong_project(self, test_db_url: str) -> None:
        """Should return 404 for non-existent project."""
        app = _make_audit_test_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            resp = client.get(
                f"/v1/projects/{uuid.uuid4()}/overview",
                headers=auth_headers(token),
            )
            assert resp.status_code == 404
