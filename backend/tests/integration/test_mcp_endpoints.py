"""Integration tests for MCP expansion endpoints.

Boots the real FastAPI app with real Postgres, exercises:
1. POST /v1/db/sql — raw SQL execution (service key only)
2. GET /v1/db/extensions — list Postgres extensions
3. GET /v1/db/migrations — list Alembic migration history
4. POST /v1/projects/{id}/pause — pause a project
5. POST /v1/projects/{id}/restore — restore a paused project
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import (
    _make_platform_app,
    _make_project_app,
    auth_headers,
    create_project,
    signup_and_get_token,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def platform_client(test_db_url: str) -> Iterator[TestClient]:
    """Platform app with auth + project routers."""
    app = _make_platform_app(test_db_url)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def project_client(test_db_url: str) -> Iterator[TestClient]:
    """Project-scoped app with db router (service role, no auth)."""
    app = _make_project_app(test_db_url)
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# POST /v1/db/sql
# ---------------------------------------------------------------------------


class TestSqlRouteExists:
    """Verify the SQL endpoint route is registered."""

    def test_sql_route_exists(self, project_client: TestClient) -> None:
        resp = project_client.post("/v1/db/sql", json={"query": "SELECT 1"})
        assert resp.status_code != 404


class TestSqlEndpointAuth:
    """SQL endpoint requires service-role API key."""

    def test_sql_rejects_anon_role(self, test_db_url: str) -> None:
        """Anon-role API keys must be rejected."""
        from collections.abc import AsyncIterator
        from contextlib import asynccontextmanager

        from fastapi import FastAPI
        from sqlalchemy.ext.asyncio import (
            AsyncSession,
            async_sessionmaker,
            create_async_engine,
        )

        from pqdb_api.middleware.api_key import (
            ProjectContext,
            get_project_context,
            get_project_session,
        )
        from pqdb_api.middleware.user_auth import get_current_user
        from pqdb_api.routes.db import router as db_router
        from pqdb_api.routes.health import router as health_router

        @asynccontextmanager
        async def lifespan(app: FastAPI) -> AsyncIterator[None]:
            engine = create_async_engine(test_db_url)
            session_factory = async_sessionmaker(
                engine, class_=AsyncSession, expire_on_commit=False
            )

            async def _override_session() -> AsyncIterator[AsyncSession]:
                async with session_factory() as session:
                    yield session

            async def _override_context() -> ProjectContext:
                return ProjectContext(
                    project_id=uuid.uuid4(),
                    key_role="anon",
                    database_name="test",
                )

            async def _override_user() -> None:
                return None

            app.dependency_overrides[get_project_session] = _override_session
            app.dependency_overrides[get_project_context] = _override_context
            app.dependency_overrides[get_current_user] = _override_user
            yield
            await engine.dispose()

        app = FastAPI(lifespan=lifespan)
        app.include_router(health_router)
        app.include_router(db_router)

        with TestClient(app) as client:
            resp = client.post("/v1/db/sql", json={"query": "SELECT 1"})
            assert resp.status_code == 403
            assert "service_role" in resp.json()["detail"]


class TestSqlEndpointReadMode:
    """POST /v1/db/sql with mode=read (default)."""

    def test_sql_select_returns_rows(self, project_client: TestClient) -> None:
        resp = project_client.post(
            "/v1/db/sql",
            json={"query": "SELECT 1 AS num, 'hello' AS greeting"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "rows" in data
        assert "columns" in data
        assert "row_count" in data
        assert data["row_count"] == 1
        assert data["columns"] == ["num", "greeting"]
        assert data["rows"][0]["num"] == 1
        assert data["rows"][0]["greeting"] == "hello"

    def test_sql_read_mode_rejects_writes(self, project_client: TestClient) -> None:
        """Read-only mode should reject DDL/DML statements."""
        # Create a temp table first (in write mode) to try writing to
        resp = project_client.post(
            "/v1/db/sql",
            json={
                "query": "CREATE TABLE _test_readonly (id serial PRIMARY KEY)",
                "mode": "write",
            },
        )
        # Now try INSERT in read mode — should fail
        resp = project_client.post(
            "/v1/db/sql",
            json={"query": "INSERT INTO _test_readonly DEFAULT VALUES"},
        )
        assert resp.status_code == 400

    def test_sql_invalid_query_returns_400(self, project_client: TestClient) -> None:
        resp = project_client.post(
            "/v1/db/sql",
            json={"query": "INVALID SQL STATEMENT"},
        )
        assert resp.status_code == 400

    def test_sql_empty_result_set(self, project_client: TestClient) -> None:
        resp = project_client.post(
            "/v1/db/sql",
            json={"query": "SELECT 1 WHERE false"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["rows"] == []
        assert data["row_count"] == 0


class TestSqlEndpointWriteMode:
    """POST /v1/db/sql with mode=write."""

    def test_sql_write_mode_allows_ddl(self, project_client: TestClient) -> None:
        resp = project_client.post(
            "/v1/db/sql",
            json={
                "query": "CREATE TABLE _test_write (id serial, name text)",
                "mode": "write",
            },
        )
        assert resp.status_code == 200

        # Verify the table exists
        resp2 = project_client.post(
            "/v1/db/sql",
            json={"query": "SELECT * FROM _test_write"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["rows"] == []

    def test_sql_write_mode_insert_and_read(
        self, project_client: TestClient
    ) -> None:
        # Create table
        project_client.post(
            "/v1/db/sql",
            json={
                "query": "CREATE TABLE _test_insert (id serial, val text)",
                "mode": "write",
            },
        )
        # Insert
        resp = project_client.post(
            "/v1/db/sql",
            json={
                "query": "INSERT INTO _test_insert (val) VALUES ('abc') RETURNING *",
                "mode": "write",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["row_count"] == 1
        assert data["rows"][0]["val"] == "abc"


class TestSqlEndpointValidation:
    """Request body validation."""

    def test_sql_missing_query_returns_422(self, project_client: TestClient) -> None:
        resp = project_client.post("/v1/db/sql", json={})
        assert resp.status_code == 422

    def test_sql_invalid_mode_returns_422(self, project_client: TestClient) -> None:
        resp = project_client.post(
            "/v1/db/sql",
            json={"query": "SELECT 1", "mode": "admin"},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /v1/db/extensions
# ---------------------------------------------------------------------------


class TestExtensionsRouteExists:
    """Verify the extensions endpoint is registered."""

    def test_extensions_route_exists(self, project_client: TestClient) -> None:
        resp = project_client.get("/v1/db/extensions")
        assert resp.status_code != 404


class TestExtensionsEndpoint:
    """GET /v1/db/extensions returns installed extensions."""

    def test_extensions_returns_list(self, project_client: TestClient) -> None:
        resp = project_client.get("/v1/db/extensions")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        # plpgsql is always installed in Postgres
        names = [ext["name"] for ext in data]
        assert "plpgsql" in names

    def test_extensions_include_version(self, project_client: TestClient) -> None:
        resp = project_client.get("/v1/db/extensions")
        assert resp.status_code == 200
        data = resp.json()
        for ext in data:
            assert "name" in ext
            assert "version" in ext
            assert isinstance(ext["version"], str)


# ---------------------------------------------------------------------------
# GET /v1/projects/migrations
# ---------------------------------------------------------------------------


class TestMigrationsRouteExists:
    """Verify the migrations endpoint is registered."""

    def test_migrations_route_exists(self, platform_client: TestClient) -> None:
        token = signup_and_get_token(platform_client)
        resp = platform_client.get(
            "/v1/projects/migrations",
            headers=auth_headers(token),
        )
        assert resp.status_code != 404


class TestMigrationsAuth:
    """Migrations endpoint requires developer JWT."""

    def test_migrations_without_auth_returns_401_or_403(
        self, platform_client: TestClient
    ) -> None:
        resp = platform_client.get("/v1/projects/migrations")
        assert resp.status_code in (401, 403)


class TestMigrationsEndpoint:
    """GET /v1/projects/migrations returns migration history."""

    def test_migrations_returns_list(self, platform_client: TestClient) -> None:
        token = signup_and_get_token(platform_client)
        resp = platform_client.get(
            "/v1/projects/migrations",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        # alembic_version may not exist in test DB — empty list is valid
        assert isinstance(data, list)

    def test_migrations_item_shape(self, platform_client: TestClient) -> None:
        """If items are returned, they must have version and applied fields."""
        token = signup_and_get_token(platform_client)
        resp = platform_client.get(
            "/v1/projects/migrations",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        for item in data:
            assert "version" in item
            assert "applied" in item


# ---------------------------------------------------------------------------
# POST /v1/projects/{id}/pause
# ---------------------------------------------------------------------------


class TestPauseRouteExists:
    """Verify the pause endpoint is registered."""

    def test_pause_route_exists(self, platform_client: TestClient) -> None:
        resp = platform_client.post(f"/v1/projects/{uuid.uuid4()}/pause")
        assert resp.status_code != 404


class TestPauseAuth:
    """Pause endpoint requires developer JWT."""

    def test_pause_without_auth_returns_401_or_403(
        self, platform_client: TestClient
    ) -> None:
        resp = platform_client.post(f"/v1/projects/{uuid.uuid4()}/pause")
        assert resp.status_code in (401, 403)


class TestPauseEndpoint:
    """POST /v1/projects/{id}/pause sets status to paused."""

    def test_pause_active_project(self, platform_client: TestClient) -> None:
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        resp = platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == project_id
        assert data["status"] == "paused"

    def test_pause_updates_project_status(self, platform_client: TestClient) -> None:
        """After pausing, GET returns the paused status."""
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )

        resp = platform_client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "paused"

    def test_pause_already_paused_returns_400(
        self, platform_client: TestClient
    ) -> None:
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        # Pause it
        platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        # Pause again — should fail
        resp = platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        assert resp.status_code == 400
        assert "Cannot pause" in resp.json()["detail"]

    def test_pause_nonexistent_project_returns_404(
        self, platform_client: TestClient
    ) -> None:
        token = signup_and_get_token(platform_client)
        resp = platform_client.post(
            f"/v1/projects/{uuid.uuid4()}/pause",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_pause_other_developers_project_returns_404(
        self, platform_client: TestClient
    ) -> None:
        token_a = signup_and_get_token(platform_client, email="pause_a@test.com")
        token_b = signup_and_get_token(platform_client, email="pause_b@test.com")
        project = create_project(platform_client, token_a, name="private-proj")
        project_id = project["id"]

        resp = platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404

    def test_paused_project_excluded_from_list(
        self, platform_client: TestClient
    ) -> None:
        """Paused projects should still appear in list (they're not archived)."""
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )

        resp = platform_client.get(
            "/v1/projects",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        projects = resp.json()
        assert len(projects) == 1
        assert projects[0]["status"] == "paused"


# ---------------------------------------------------------------------------
# POST /v1/projects/{id}/restore
# ---------------------------------------------------------------------------


class TestRestoreRouteExists:
    """Verify the restore endpoint is registered."""

    def test_restore_route_exists(self, platform_client: TestClient) -> None:
        resp = platform_client.post(f"/v1/projects/{uuid.uuid4()}/restore")
        assert resp.status_code != 404


class TestRestoreAuth:
    """Restore endpoint requires developer JWT."""

    def test_restore_without_auth_returns_401_or_403(
        self, platform_client: TestClient
    ) -> None:
        resp = platform_client.post(f"/v1/projects/{uuid.uuid4()}/restore")
        assert resp.status_code in (401, 403)


class TestRestoreEndpoint:
    """POST /v1/projects/{id}/restore sets status back to active."""

    def test_restore_paused_project(self, platform_client: TestClient) -> None:
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        # Pause first
        platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        # Restore
        resp = platform_client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == project_id
        assert data["status"] == "active"

    def test_restore_archived_project(self, platform_client: TestClient) -> None:
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        # Archive (delete)
        platform_client.delete(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        # Restore
        resp = platform_client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "active"

    def test_restore_active_project_returns_400(
        self, platform_client: TestClient
    ) -> None:
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        resp = platform_client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )
        assert resp.status_code == 400
        assert "Cannot restore" in resp.json()["detail"]

    def test_restore_nonexistent_project_returns_404(
        self, platform_client: TestClient
    ) -> None:
        token = signup_and_get_token(platform_client)
        resp = platform_client.post(
            f"/v1/projects/{uuid.uuid4()}/restore",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_restore_other_developers_project_returns_404(
        self, platform_client: TestClient
    ) -> None:
        token_a = signup_and_get_token(platform_client, email="restore_a@test.com")
        token_b = signup_and_get_token(platform_client, email="restore_b@test.com")
        project = create_project(platform_client, token_a, name="restore-priv")
        project_id = project["id"]

        # Pause it with owner
        platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token_a),
        )

        # Try restore with different developer
        resp = platform_client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404

    def test_restore_updates_project_status(
        self, platform_client: TestClient
    ) -> None:
        """After restoring, GET returns the active status."""
        token = signup_and_get_token(platform_client)
        project = create_project(platform_client, token)
        project_id = project["id"]

        platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        platform_client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )

        resp = platform_client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "active"


# ---------------------------------------------------------------------------
# Full pause/restore flow
# ---------------------------------------------------------------------------


class TestPauseRestoreFlow:
    """End-to-end: create -> pause -> restore -> verify."""

    def test_full_pause_restore_cycle(self, platform_client: TestClient) -> None:
        token = signup_and_get_token(platform_client, email="flow@test.com")
        project = create_project(platform_client, token)
        project_id = project["id"]
        assert project["status"] == "active"

        # Pause
        pause_resp = platform_client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        assert pause_resp.status_code == 200
        assert pause_resp.json()["status"] == "paused"

        # Verify via GET
        get_resp = platform_client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert get_resp.json()["status"] == "paused"

        # Restore
        restore_resp = platform_client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )
        assert restore_resp.status_code == 200
        assert restore_resp.json()["status"] == "active"

        # Verify via GET again
        get_resp2 = platform_client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert get_resp2.json()["status"] == "active"
