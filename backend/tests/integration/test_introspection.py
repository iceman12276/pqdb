"""Integration tests for schema introspection (US-013).

Boots the real FastAPI app with an in-process SQLite database.
The project session dependency is overridden to use the same
in-memory SQLite DB, bypassing API key auth. Tests verify that
introspection returns accurate schema metadata after table
creation.
"""

from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import StaticPool, event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.middleware.api_key import get_project_session
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router


def _create_test_app() -> FastAPI:
    """Create a minimal test app with in-memory SQLite."""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(  # type: ignore[no-untyped-def]
        dbapi_conn,
        connection_record,
    ):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    session_factory = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    async def _override() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(health_router)
    app.include_router(db_router)
    app.dependency_overrides[get_project_session] = _override
    return app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = _create_test_app()
    with TestClient(app) as c:
        yield c


def _create_mixed_table(
    client: TestClient,
    name: str = "users",
) -> None:
    """Helper to create a table with mixed sensitivity."""
    client.post(
        "/v1/db/tables",
        json={
            "name": name,
            "columns": [
                {
                    "name": "display_name",
                    "data_type": "text",
                    "sensitivity": "plain",
                },
                {
                    "name": "email",
                    "data_type": "text",
                    "sensitivity": "searchable",
                },
                {
                    "name": "ssn",
                    "data_type": "text",
                    "sensitivity": "private",
                },
            ],
        },
    )


class TestIntrospectRouteExists:
    """Verify introspection routes are registered."""

    def test_introspect_all_route_exists(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/introspect")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_introspect_table_route_exists(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/introspect/anything")
        assert resp.status_code != 405


class TestIntrospectAllEmpty:
    """Test GET /v1/db/introspect with no tables."""

    def test_returns_empty_tables_list(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/introspect")
        assert resp.status_code == 200
        assert resp.json() == {"tables": []}


class TestIntrospectAllWithTables:
    """Test GET /v1/db/introspect after creating tables."""

    def test_returns_created_tables(
        self,
        client: TestClient,
    ) -> None:
        _create_mixed_table(client)
        resp = client.get("/v1/db/introspect")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["tables"]) == 1
        assert data["tables"][0]["name"] == "users"

    def test_returns_correct_column_metadata(
        self,
        client: TestClient,
    ) -> None:
        _create_mixed_table(client, "profiles")
        resp = client.get("/v1/db/introspect")
        data = resp.json()
        table = data["tables"][0]
        col_map = {c["name"]: c for c in table["columns"]}

        # plain column
        assert col_map["display_name"]["type"] == "text"
        s = col_map["display_name"]["sensitivity"]
        assert s == "plain"
        assert col_map["display_name"]["queryable"] is True
        assert col_map["display_name"]["operations"] == [
            "eq",
            "gt",
            "lt",
            "gte",
            "lte",
            "in",
            "between",
        ]

        # searchable column
        assert col_map["email"]["type"] == "text"
        assert col_map["email"]["sensitivity"] == "searchable"
        assert col_map["email"]["queryable"] is True
        assert col_map["email"]["operations"] == [
            "eq",
            "in",
        ]

        # private column
        assert col_map["ssn"]["type"] == "text"
        assert col_map["ssn"]["sensitivity"] == "private"
        assert col_map["ssn"]["queryable"] is False
        assert "operations" not in col_map["ssn"]
        assert col_map["ssn"]["note"] == (
            "retrieve only \u2014 no server-side filtering"
        )

    def test_returns_sensitivity_summary(
        self,
        client: TestClient,
    ) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [
                    {
                        "name": "title",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {
                        "name": "price",
                        "data_type": "integer",
                        "sensitivity": "plain",
                    },
                    {
                        "name": "sku",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                ],
            },
        )

        resp = client.get("/v1/db/introspect")
        data = resp.json()
        summary = data["tables"][0]["sensitivity_summary"]
        assert summary == {
            "searchable": 1,
            "private": 0,
            "plain": 2,
        }

    def test_introspect_multiple_tables(
        self,
        client: TestClient,
    ) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "alpha",
                "columns": [
                    {"name": "x", "data_type": "text"},
                ],
            },
        )
        client.post(
            "/v1/db/tables",
            json={
                "name": "beta",
                "columns": [
                    {"name": "y", "data_type": "integer"},
                ],
            },
        )

        resp = client.get("/v1/db/introspect")
        data = resp.json()
        names = [t["name"] for t in data["tables"]]
        assert "alpha" in names
        assert "beta" in names


class TestIntrospectSingleTable:
    """Test GET /v1/db/introspect/{table_name}."""

    def test_introspect_existing_table(
        self,
        client: TestClient,
    ) -> None:
        _create_mixed_table(client, "target")
        resp = client.get("/v1/db/introspect/target")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "target"
        assert len(data["columns"]) == 3
        assert "sensitivity_summary" in data

    def test_nonexistent_table_returns_404(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/introspect/missing")
        assert resp.status_code == 404

    def test_returns_full_metadata(
        self,
        client: TestClient,
    ) -> None:
        _create_mixed_table(client, "fullmeta")
        resp = client.get("/v1/db/introspect/fullmeta")
        data = resp.json()
        col_map = {c["name"]: c for c in data["columns"]}

        assert col_map["display_name"]["queryable"] is True
        assert col_map["display_name"]["operations"] == [
            "eq",
            "gt",
            "lt",
            "gte",
            "lte",
            "in",
            "between",
        ]
        assert col_map["ssn"]["queryable"] is False
        assert col_map["email"]["queryable"] is True
        assert col_map["email"]["operations"] == [
            "eq",
            "in",
        ]

    def test_sensitivity_summary(
        self,
        client: TestClient,
    ) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "counted",
                "columns": [
                    {
                        "name": "a",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                    {
                        "name": "b",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                    {
                        "name": "c",
                        "data_type": "text",
                        "sensitivity": "private",
                    },
                ],
            },
        )

        resp = client.get("/v1/db/introspect/counted")
        data = resp.json()
        assert data["sensitivity_summary"] == {
            "searchable": 2,
            "private": 1,
            "plain": 0,
        }

    def test_invalid_table_name_returns_400(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/introspect/1invalid")
        assert resp.status_code == 400


class TestHealthStillWorks:
    """Health check still works with introspect routes."""

    def test_health_returns_200(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
