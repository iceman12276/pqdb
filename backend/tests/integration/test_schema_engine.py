"""Integration tests for schema engine — table creation with shadow columns (US-010).

Boots the real FastAPI app with an in-process SQLite database.
The project session dependency is overridden to use the same in-memory
SQLite DB, bypassing API key auth (which is tested separately in
test_request_routing.py). This lets us test schema engine behavior
in isolation.
"""

from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import StaticPool, event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.middleware.api_key import get_project_session
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router


def _create_test_app() -> FastAPI:
    """Create a minimal test FastAPI app with in-memory SQLite.

    Only includes db and health routers. Overrides get_project_session
    to use in-memory SQLite (no real project DB provisioning needed).
    """
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

    async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
        async with test_session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(health_router)
    app.include_router(db_router)
    app.dependency_overrides[get_project_session] = _override_get_project_session
    return app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = _create_test_app()
    with TestClient(app) as c:
        yield c


class TestTableRouteExists:
    """Verify table management routes are registered."""

    def test_post_tables_route_exists(self, client: TestClient) -> None:
        resp = client.post("/v1/db/tables", json={})
        assert resp.status_code != 404

    def test_get_tables_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/tables")
        assert resp.status_code != 404

    def test_get_table_by_name_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/tables/anything")
        # 404 here means "table not found", not "route not found".
        # A missing route would return 405 Method Not Allowed.
        assert resp.status_code != 405


class TestCreateTablePlainColumns:
    """Test creating tables with plain (unencrypted) columns."""

    def test_create_table_returns_201(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "users",
                "columns": [{"name": "name", "data_type": "text"}],
            },
        )
        assert resp.status_code == 201

    def test_create_table_returns_schema(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "users",
                "columns": [
                    {"name": "name", "data_type": "text"},
                    {"name": "age", "data_type": "integer"},
                ],
            },
        )
        data = resp.json()
        assert data["name"] == "users"
        assert len(data["columns"]) == 2
        assert data["columns"][0]["name"] == "name"
        assert data["columns"][0]["sensitivity"] == "plain"
        assert data["columns"][0]["data_type"] == "text"

    def test_default_sensitivity_is_plain(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [{"name": "title", "data_type": "text"}],
            },
        )
        data = resp.json()
        assert data["columns"][0]["sensitivity"] == "plain"


class TestCreateTableSensitiveColumns:
    """Test creating tables with sensitive (encrypted) columns."""

    def test_private_column_recorded(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "secrets",
                "columns": [
                    {"name": "ssn", "data_type": "text", "sensitivity": "private"},
                ],
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["columns"][0]["sensitivity"] == "private"

    def test_searchable_column_recorded(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "contacts",
                "columns": [
                    {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                ],
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["columns"][0]["sensitivity"] == "searchable"

    def test_mixed_sensitivity_columns(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "profiles",
                "columns": [
                    {
                        "name": "display_name",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                    {"name": "ssn", "data_type": "text", "sensitivity": "private"},
                ],
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        sensitivities = {c["name"]: c["sensitivity"] for c in data["columns"]}
        assert sensitivities["display_name"] == "plain"
        assert sensitivities["email"] == "searchable"
        assert sensitivities["ssn"] == "private"


class TestCreateTableValidation:
    """Test validation errors on table creation."""

    def test_empty_table_name_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "",
                "columns": [{"name": "x", "data_type": "text"}],
            },
        )
        assert resp.status_code == 400

    def test_invalid_sensitivity_returns_422(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "bad",
                "columns": [
                    {"name": "x", "data_type": "text", "sensitivity": "encrypted"},
                ],
            },
        )
        assert resp.status_code == 422

    def test_no_columns_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={"name": "empty", "columns": []},
        )
        assert resp.status_code == 400

    def test_duplicate_table_name_returns_409(self, client: TestClient) -> None:
        # Create first time
        resp1 = client.post(
            "/v1/db/tables",
            json={
                "name": "duped",
                "columns": [{"name": "x", "data_type": "text"}],
            },
        )
        assert resp1.status_code == 201

        # Create again — should conflict
        resp2 = client.post(
            "/v1/db/tables",
            json={
                "name": "duped",
                "columns": [{"name": "y", "data_type": "text"}],
            },
        )
        assert resp2.status_code == 409


class TestListTables:
    """Test GET /v1/db/tables."""

    def test_empty_project_returns_empty_list(self, client: TestClient) -> None:
        resp = client.get("/v1/db/tables")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_lists_created_tables(self, client: TestClient) -> None:
        # Create two tables
        client.post(
            "/v1/db/tables",
            json={
                "name": "alpha",
                "columns": [{"name": "x", "data_type": "text"}],
            },
        )
        client.post(
            "/v1/db/tables",
            json={
                "name": "beta",
                "columns": [{"name": "y", "data_type": "integer"}],
            },
        )

        resp = client.get("/v1/db/tables")
        assert resp.status_code == 200
        data = resp.json()
        names = [t["name"] for t in data]
        assert "alpha" in names
        assert "beta" in names

    def test_list_includes_column_metadata(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "detailed",
                "columns": [
                    {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                ],
            },
        )

        resp = client.get("/v1/db/tables")
        data = resp.json()
        table = next(t for t in data if t["name"] == "detailed")
        assert table["columns"][0]["sensitivity"] == "searchable"


class TestGetTable:
    """Test GET /v1/db/tables/{name}."""

    def test_get_existing_table(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "target",
                "columns": [
                    {"name": "name", "data_type": "text", "sensitivity": "plain"},
                    {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                ],
            },
        )

        resp = client.get("/v1/db/tables/target")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "target"
        assert len(data["columns"]) == 2

    def test_get_nonexistent_table_returns_404(self, client: TestClient) -> None:
        resp = client.get("/v1/db/tables/missing")
        assert resp.status_code == 404

    def test_get_table_returns_full_metadata(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "fullmeta",
                "columns": [
                    {
                        "name": "display_name",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {"name": "ssn", "data_type": "text", "sensitivity": "private"},
                    {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                ],
            },
        )

        resp = client.get("/v1/db/tables/fullmeta")
        data = resp.json()
        col_map = {c["name"]: c for c in data["columns"]}
        assert col_map["display_name"]["sensitivity"] == "plain"
        assert col_map["ssn"]["sensitivity"] == "private"
        assert col_map["email"]["sensitivity"] == "searchable"


class TestPlatformHealthUnaffected:
    """Platform health check still works with table routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
