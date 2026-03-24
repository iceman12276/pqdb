"""Integration tests for scoped API key permission enforcement (US-086).

Boots the real FastAPI app with a real Postgres database,
exercises that scoped keys can only access allowed tables/operations
and are rejected for disallowed ones.
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


def _make_scoped_key_app(test_db_url: str) -> FastAPI:
    """Build a test app that validates API keys for real but uses the
    test DB for project-scoped CRUD operations.

    This lets us test the full middleware flow (key parsing, permission
    loading) while pointing CRUD queries at the test database where we
    can create tables.
    """
    from pqdb_api.middleware.api_key import get_project_session

    app = _make_platform_app(test_db_url, include_db_router=True)

    # Override get_project_session to use the test DB instead of the
    # (nonexistent) project-specific DB.
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
    app = _make_scoped_key_app(test_db_url)
    with TestClient(app) as c:
        yield c


def _setup_project_with_table(
    client: TestClient,
    email: str,
    project_name: str,
    table_name: str = "notes",
) -> tuple[str, str, list[dict[str, str]]]:
    """Create a developer, project, and a table in the project DB.

    Returns (project_id, service_key, all_keys).
    """
    token = signup_and_get_token(client, email=email)
    project = create_project(client, token, name=project_name)
    project_id = project["id"]
    api_keys = project["api_keys"]
    svc_key = next(k["key"] for k in api_keys if k["role"] == "service")

    # Create a table using the service key
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": table_name,
            "columns": [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
                {"name": "body", "data_type": "text", "sensitivity": "plain"},
            ],
        },
        headers={"apikey": svc_key},
    )
    assert resp.status_code == 201, f"Failed to create table: {resp.text}"

    return project_id, svc_key, api_keys


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


class TestScopedKeyHealthCheck:
    """Scoped keys can authenticate to /v1/db/health."""

    def test_scoped_key_authenticates_successfully(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="scope-health@test.com")
        project = create_project(client, token, name="scope-health-proj")
        project_id = project["id"]

        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="health-key",
            permissions={"tables": {"notes": ["select"]}},
        )

        resp = client.get("/v1/db/health", headers={"apikey": scoped_key})
        assert resp.status_code == 200
        assert resp.json()["role"] == "scoped"
        assert resp.json()["project_id"] == project_id


class TestScopedKeySelectAllowed:
    """Scoped key with select permission can read from allowed table."""

    def test_select_on_allowed_table_returns_200(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="sel-ok@test.com")
        project = create_project(client, token, name="sel-ok-proj")
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
            name="read-notes",
            permissions={"tables": {"notes": ["select"]}},
        )

        resp = client.post(
            "/v1/db/notes/select",
            json={"columns": ["*"]},
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 200
        assert "data" in resp.json()


class TestScopedKeySelectDenied:
    """Scoped key without table access is rejected with 403."""

    def test_select_on_disallowed_table_returns_403(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="sel-deny@test.com")
        project = create_project(client, token, name="sel-deny-proj")
        project_id = project["id"]
        svc_key = next(k["key"] for k in project["api_keys"] if k["role"] == "service")

        # Create two tables
        for tbl in ("notes", "secrets"):
            client.post(
                "/v1/db/tables",
                json={
                    "name": tbl,
                    "columns": [
                        {"name": "title", "data_type": "text", "sensitivity": "plain"},
                    ],
                },
                headers={"apikey": svc_key},
            )

        # Scoped key only has access to "notes"
        scoped_key = _create_scoped_key(
            client,
            token,
            project_id,
            name="notes-only",
            permissions={"tables": {"notes": ["select"]}},
        )

        # Access to notes should work
        resp_ok = client.post(
            "/v1/db/notes/select",
            json={"columns": ["*"]},
            headers={"apikey": scoped_key},
        )
        assert resp_ok.status_code == 200

        # Access to secrets should be denied
        resp_deny = client.post(
            "/v1/db/secrets/select",
            json={"columns": ["*"]},
            headers={"apikey": scoped_key},
        )
        assert resp_deny.status_code == 403
        assert "not allowed" in resp_deny.json()["detail"]


class TestScopedKeyOperationDenied:
    """Scoped key with select-only is rejected for insert/update/delete."""

    def test_insert_denied_for_select_only_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="op-deny1@test.com")
        project = create_project(client, token, name="op-deny-proj-1")
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
            name="select-only",
            permissions={"tables": {"notes": ["select"]}},
        )

        resp = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "secret"}]},
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 403
        assert "not allowed" in resp.json()["detail"]
        assert "insert" in resp.json()["detail"]

    def test_update_denied_for_select_only_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="op-deny2@test.com")
        project = create_project(client, token, name="op-deny-proj-2")
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
            name="select-only",
            permissions={"tables": {"notes": ["select"]}},
        )

        resp = client.post(
            "/v1/db/notes/update",
            json={"values": {"title": "hack"}, "filters": []},
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 403
        assert "not allowed" in resp.json()["detail"]
        assert "update" in resp.json()["detail"]

    def test_delete_denied_for_select_only_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="op-deny3@test.com")
        project = create_project(client, token, name="op-deny-proj-3")
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
            name="select-only",
            permissions={"tables": {"notes": ["select"]}},
        )

        resp = client.post(
            "/v1/db/notes/delete",
            json={"filters": []},
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 403
        assert "not allowed" in resp.json()["detail"]
        assert "delete" in resp.json()["detail"]


class TestScopedKeyInsertAllowed:
    """Scoped key with insert permission can insert rows."""

    def test_insert_on_allowed_table_succeeds(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="ins-ok@test.com")
        project = create_project(client, token, name="ins-ok-proj")
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
            name="insert-notes",
            permissions={"tables": {"notes": ["select", "insert"]}},
        )

        resp = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "Hello"}]},
            headers={"apikey": scoped_key},
        )
        assert resp.status_code == 201
        assert len(resp.json()["data"]) == 1


class TestServiceKeyBypassesPermissions:
    """Service keys always have full access regardless of any scoping."""

    def test_service_key_full_access(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="svc-bypass@test.com")
        project = create_project(client, token, name="svc-bypass-proj")
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

        # Service key can do all operations
        resp_insert = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "test"}]},
            headers={"apikey": svc_key},
        )
        assert resp_insert.status_code == 201

        resp_select = client.post(
            "/v1/db/notes/select",
            json={"columns": ["*"]},
            headers={"apikey": svc_key},
        )
        assert resp_select.status_code == 200


class TestLegacyKeyBackwardCompatibility:
    """Legacy keys (null permissions) retain full access."""

    def test_anon_key_null_permissions_has_full_access(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client, email="legacy@test.com")
        project = create_project(client, token, name="legacy-proj")
        anon_key = next(k["key"] for k in project["api_keys"] if k["role"] == "anon")
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

        # Anon key (null permissions) can select
        resp = client.post(
            "/v1/db/notes/select",
            json={"columns": ["*"]},
            headers={"apikey": anon_key},
        )
        assert resp.status_code == 200

        # Anon key can insert
        resp_insert = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "hello"}]},
            headers={"apikey": anon_key},
        )
        assert resp_insert.status_code == 201
