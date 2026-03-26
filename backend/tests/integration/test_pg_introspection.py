"""Integration tests for Postgres catalog introspection endpoints (US-096).

Boots the real FastAPI app with a real Postgres database.
Creates database objects (functions, triggers, enums, extensions, indexes,
publications) via raw SQL, then verifies the introspection endpoints
return them correctly.
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

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.middleware.user_auth import get_current_user
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.introspection import router as introspection_router


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    """Build a test client with introspection router registered first.

    Introspection router is registered before db_router so enhanced
    endpoints (e.g. /extensions with schema+comment) take precedence.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        async def _override_project_context() -> ProjectContext:
            return ProjectContext(
                project_id=uuid.uuid4(),
                key_role="service",
                database_name="test",
            )

        async def _override_current_user() -> None:
            return None

        app.dependency_overrides[get_project_session] = _override_get_project_session
        app.dependency_overrides[get_project_context] = _override_project_context
        app.dependency_overrides[get_current_user] = _override_current_user
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(introspection_router)
    app.include_router(db_router)
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Helper: execute raw SQL via the test client's project session
# ---------------------------------------------------------------------------
def _exec_sql(client: TestClient, sql: str) -> None:
    """Execute raw SQL by posting to /v1/db/sql endpoint."""
    resp = client.post("/v1/db/sql", json={"query": sql, "mode": "write"})
    assert resp.status_code == 200, f"SQL failed: {resp.text}"


# ===========================================================================
# Functions
# ===========================================================================
class TestFunctions:
    """GET /v1/db/functions — queries pg_proc + pg_namespace."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/functions")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_empty_when_no_user_functions(self, client: TestClient) -> None:
        resp = client.get("/v1/db/functions")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_created_function(self, client: TestClient) -> None:
        _exec_sql(
            client,
            """
            CREATE OR REPLACE FUNCTION test_add(a integer, b integer)
            RETURNS integer
            LANGUAGE sql
            AS $$ SELECT a + b $$
            """,
        )
        resp = client.get("/v1/db/functions")
        assert resp.status_code == 200
        data = resp.json()
        names = [f["name"] for f in data]
        assert "test_add" in names

        fn = next(f for f in data if f["name"] == "test_add")
        assert fn["schema"] == "public"
        assert fn["return_type"] == "int4"
        assert fn["language"] == "sql"
        assert "source" in fn

    def test_excludes_system_functions(self, client: TestClient) -> None:
        """System schema functions (pg_catalog) must not appear."""
        resp = client.get("/v1/db/functions")
        assert resp.status_code == 200
        data = resp.json()
        schemas = {f["schema"] for f in data}
        assert "pg_catalog" not in schemas
        assert "information_schema" not in schemas


# ===========================================================================
# Triggers
# ===========================================================================
class TestTriggers:
    """GET /v1/db/triggers — queries pg_trigger + pg_class."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/triggers")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_empty_when_no_user_triggers(self, client: TestClient) -> None:
        resp = client.get("/v1/db/triggers")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_created_trigger(self, client: TestClient) -> None:
        _exec_sql(
            client,
            """
            CREATE TABLE trigger_test (id serial PRIMARY KEY, name text);
            """,
        )
        _exec_sql(
            client,
            """
            CREATE OR REPLACE FUNCTION trigger_fn()
            RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN RETURN NEW; END; $$;
            """,
        )
        _exec_sql(
            client,
            """
            CREATE TRIGGER my_trigger
            BEFORE INSERT ON trigger_test
            FOR EACH ROW EXECUTE FUNCTION trigger_fn();
            """,
        )
        resp = client.get("/v1/db/triggers")
        assert resp.status_code == 200
        data = resp.json()
        names = [t["name"] for t in data]
        assert "my_trigger" in names

        trg = next(t for t in data if t["name"] == "my_trigger")
        assert trg["table"] == "trigger_test"
        assert "INSERT" in trg["events"]
        assert trg["timing"] == "BEFORE"
        assert trg["function_name"] == "trigger_fn"


# ===========================================================================
# Enums
# ===========================================================================
class TestEnums:
    """GET /v1/db/enums — queries pg_type + pg_enum."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/enums")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_empty_when_no_user_enums(self, client: TestClient) -> None:
        resp = client.get("/v1/db/enums")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_created_enum(self, client: TestClient) -> None:
        _exec_sql(
            client,
            "CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral')",
        )
        resp = client.get("/v1/db/enums")
        assert resp.status_code == 200
        data = resp.json()
        names = [e["name"] for e in data]
        assert "mood" in names

        enum = next(e for e in data if e["name"] == "mood")
        assert enum["schema"] == "public"
        assert enum["values"] == ["happy", "sad", "neutral"]


# ===========================================================================
# Extensions
# ===========================================================================
class TestExtensions:
    """GET /v1/db/extensions — queries pg_extension."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/extensions")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_returns_default_extensions(self, client: TestClient) -> None:
        """plpgsql is always installed by default."""
        resp = client.get("/v1/db/extensions")
        assert resp.status_code == 200
        data = resp.json()
        names = [e["name"] for e in data]
        assert "plpgsql" in names

    def test_returns_created_extension(self, client: TestClient) -> None:
        _exec_sql(client, "CREATE EXTENSION IF NOT EXISTS pgcrypto")
        resp = client.get("/v1/db/extensions")
        assert resp.status_code == 200
        data = resp.json()
        names = [e["name"] for e in data]
        assert "pgcrypto" in names

        ext = next(e for e in data if e["name"] == "pgcrypto")
        assert "version" in ext
        assert "schema" in ext

    def test_extension_has_comment(self, client: TestClient) -> None:
        """Extensions typically have a comment from their control file."""
        resp = client.get("/v1/db/extensions")
        data = resp.json()
        plpgsql = next(e for e in data if e["name"] == "plpgsql")
        assert "comment" in plpgsql


# ===========================================================================
# Indexes
# ===========================================================================
class TestIndexes:
    """GET /v1/db/indexes — queries pg_indexes view."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/indexes")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_returns_created_index(self, client: TestClient) -> None:
        _exec_sql(
            client,
            "CREATE TABLE idx_test (id serial PRIMARY KEY, name text, age int)",
        )
        _exec_sql(
            client,
            "CREATE INDEX idx_name ON idx_test (name)",
        )
        resp = client.get("/v1/db/indexes")
        assert resp.status_code == 200
        data = resp.json()
        names = [i["name"] for i in data]
        assert "idx_name" in names

        idx = next(i for i in data if i["name"] == "idx_name")
        assert idx["table"] == "idx_test"
        assert "definition" in idx
        assert idx["unique"] is False

    def test_unique_index_marked(self, client: TestClient) -> None:
        _exec_sql(
            client,
            "CREATE TABLE uniq_test (id serial PRIMARY KEY, code text)",
        )
        _exec_sql(
            client,
            "CREATE UNIQUE INDEX idx_code ON uniq_test (code)",
        )
        resp = client.get("/v1/db/indexes")
        data = resp.json()
        idx = next(i for i in data if i["name"] == "idx_code")
        assert idx["unique"] is True

    def test_excludes_pqdb_internal_tables(self, client: TestClient) -> None:
        """Indexes on _pqdb_* tables should not appear."""
        resp = client.get("/v1/db/indexes")
        data = resp.json()
        for idx in data:
            assert not idx["table"].startswith("_pqdb_")


# ===========================================================================
# Publications
# ===========================================================================
class TestPublications:
    """GET /v1/db/publications — queries pg_publication."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/publications")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_empty_when_no_publications(self, client: TestClient) -> None:
        resp = client.get("/v1/db/publications")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_created_publication(self, client: TestClient) -> None:
        _exec_sql(
            client,
            "CREATE TABLE pub_test (id serial PRIMARY KEY, val text)",
        )
        _exec_sql(
            client,
            "CREATE PUBLICATION my_pub FOR TABLE pub_test",
        )
        resp = client.get("/v1/db/publications")
        assert resp.status_code == 200
        data = resp.json()
        names = [p["name"] for p in data]
        assert "my_pub" in names

        pub = next(p for p in data if p["name"] == "my_pub")
        assert pub["all_tables"] is False
        assert pub["insert"] is True
        assert pub["update"] is True
        assert pub["delete"] is True
        assert "pub_test" in pub["tables"]


# ===========================================================================
# Health check still works
# ===========================================================================
class TestHealthStillWorks:
    """Health check unaffected by introspection router."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
