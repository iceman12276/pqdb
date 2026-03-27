"""Integration tests for DDL blocking on scoped API keys (US-089).

Boots the real FastAPI app with a real Postgres database.
Verifies that scoped API keys are blocked from DDL operations
(create table, add column, drop column) while read-only
introspection remains allowed.
"""

from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from tests.integration.conftest import (
    _make_platform_app,
    auth_headers,
    create_project,
    signup_and_get_token,
)


def _make_scoped_ddl_app(test_db_url: str) -> FastAPI:
    """Build a test app with real API key validation and project-scoped DB."""
    from pqdb_api.middleware.api_key import get_project_session

    app = _make_platform_app(test_db_url, include_db_router=True)

    engine = create_async_engine(test_db_url)
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    async def _override_project_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_project_session] = _override_project_session
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_scoped_ddl_app(test_db_url)
    with TestClient(app) as c:
        yield c


def _create_scoped_key(
    client: TestClient,
    token: str,
    project_id: str,
    name: str,
    permissions: dict[str, Any],
) -> str:
    """Create a scoped key and return the full key string."""
    resp = client.post(
        f"/v1/projects/{project_id}/keys/scoped",
        json={"name": name, "permissions": permissions},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    key: str = resp.json()["key"]
    return key


DDL_DENIED_ERROR = {
    "error": {
        "code": "SCOPED_KEY_DDL_DENIED",
        "message": (
            "Scoped API keys cannot perform schema operations. "
            "Use an anon or service key."
        ),
    }
}


class TestScopedKeyCreateTableBlocked:
    """Scoped keys cannot create tables (POST /v1/db/tables)."""

    def test_scoped_key_create_table_returns_403(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-ct@test.com")
        project = create_project(client, token, name="ddl-ct-proj")
        project_id = project["id"]

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="crud-only",
            permissions={"tables": {"notes": ["select", "insert"]}},
        )

        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "hacked",
                "columns": [
                    {"name": "data", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == DDL_DENIED_ERROR


class TestScopedKeyAddColumnBlocked:
    """Scoped keys cannot add columns (POST /v1/db/tables/{name}/columns)."""

    def test_scoped_key_add_column_returns_403(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-ac@test.com")
        project = create_project(client, token, name="ddl-ac-proj")
        project_id = project["id"]
        svc_key = next(k["key"] for k in project["api_keys"] if k["role"] == "service")

        # Create table via service key first
        client.post(
            "/v1/db/tables",
            json={
                "name": "notes",
                "columns": [
                    {"name": "title", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": svc_key},
        )

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="crud-only",
            permissions={"tables": {"notes": ["select", "insert"]}},
        )

        resp = client.post(
            "/v1/db/tables/notes/columns",
            json={"name": "extra", "data_type": "text", "sensitivity": "plain"},
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == DDL_DENIED_ERROR


class TestScopedKeyDropColumnBlocked:
    """Scoped keys cannot drop columns (DELETE /v1/db/tables/{name}/columns/{name})."""

    def test_scoped_key_drop_column_returns_403(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-dc@test.com")
        project = create_project(client, token, name="ddl-dc-proj")
        project_id = project["id"]
        svc_key = next(k["key"] for k in project["api_keys"] if k["role"] == "service")

        # Create table with two columns via service key
        client.post(
            "/v1/db/tables",
            json={
                "name": "notes",
                "columns": [
                    {"name": "title", "data_type": "text", "sensitivity": "plain"},
                    {"name": "body", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": svc_key},
        )

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="crud-only",
            permissions={"tables": {"notes": ["select"]}},
        )

        resp = client.delete(
            "/v1/db/tables/notes/columns/body",
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == DDL_DENIED_ERROR


class TestScopedKeyIntrospectionAllowed:
    """Scoped keys can still use read-only introspection endpoints."""

    def test_scoped_key_list_tables_returns_200(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-lt@test.com")
        project = create_project(client, token, name="ddl-lt-proj")
        project_id = project["id"]
        svc_key = next(k["key"] for k in project["api_keys"] if k["role"] == "service")

        # Create table via service key
        client.post(
            "/v1/db/tables",
            json={
                "name": "notes",
                "columns": [
                    {"name": "title", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": svc_key},
        )

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="readonly",
            permissions={"tables": {"notes": ["select"]}},
        )

        # GET /v1/db/tables — list tables
        resp = client.get("/v1/db/tables", headers={"apikey": scoped_key})
        assert resp.status_code == 200

    def test_scoped_key_get_table_returns_200(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-gt@test.com")
        project = create_project(client, token, name="ddl-gt-proj")
        project_id = project["id"]
        svc_key = next(k["key"] for k in project["api_keys"] if k["role"] == "service")

        client.post(
            "/v1/db/tables",
            json={
                "name": "notes",
                "columns": [
                    {"name": "title", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": svc_key},
        )

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="readonly",
            permissions={"tables": {"notes": ["select"]}},
        )

        # GET /v1/db/tables/{name} — get single table
        resp = client.get("/v1/db/tables/notes", headers={"apikey": scoped_key})
        assert resp.status_code == 200

    def test_scoped_key_introspect_all_returns_200(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-ia@test.com")
        project = create_project(client, token, name="ddl-ia-proj")
        project_id = project["id"]

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="readonly",
            permissions={"tables": {"notes": ["select"]}},
        )

        # GET /v1/db/introspect — introspect all
        resp = client.get("/v1/db/introspect", headers={"apikey": scoped_key})
        assert resp.status_code == 200

    def test_scoped_key_introspect_table_returns_200(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-it@test.com")
        project = create_project(client, token, name="ddl-it-proj")
        project_id = project["id"]
        svc_key = next(k["key"] for k in project["api_keys"] if k["role"] == "service")

        client.post(
            "/v1/db/tables",
            json={
                "name": "notes",
                "columns": [
                    {"name": "title", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": svc_key},
        )

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="readonly",
            permissions={"tables": {"notes": ["select"]}},
        )

        # GET /v1/db/introspect/{name} — introspect single table
        resp = client.get("/v1/db/introspect/notes", headers={"apikey": scoped_key})
        assert resp.status_code == 200


class TestServiceKeyDDLAllowed:
    """Service keys retain full DDL access."""

    def test_service_key_create_table_returns_201(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-svc@test.com")
        project = create_project(client, token, name="ddl-svc-proj")
        svc_key = next(k["key"] for k in project["api_keys"] if k["role"] == "service")

        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "allowed_table",
                "columns": [
                    {"name": "data", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 201


class TestAnonKeyDDLAllowed:
    """Anon keys retain full DDL access (backward compatible)."""

    def test_anon_key_create_table_returns_201(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ddl-anon@test.com")
        project = create_project(client, token, name="ddl-anon-proj")
        anon_key = next(k["key"] for k in project["api_keys"] if k["role"] == "anon")

        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "anon_table",
                "columns": [
                    {"name": "data", "data_type": "text", "sensitivity": "plain"},
                ],
            },
            headers={"apikey": anon_key},
        )
        assert resp.status_code == 201
