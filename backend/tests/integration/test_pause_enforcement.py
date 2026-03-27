"""Integration tests for pause enforcement in API key middleware (US-088).

Boots the real FastAPI app with a real Postgres database.
Tests that paused projects reject CRUD requests with 403,
restored projects allow CRUD, and management endpoints still work
when a project is paused.
"""

from collections.abc import AsyncIterator, Iterator

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


def _make_pause_test_app(test_db_url: str) -> FastAPI:
    """Build a test app with both platform and db routes.

    Overrides get_project_session to use the test DB so CRUD
    endpoints work against a real database.
    """
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
    app = _make_pause_test_app(test_db_url)
    with TestClient(app) as c:
        yield c


def _setup_project_with_table(
    client: TestClient,
) -> tuple[str, str, str]:
    """Create a developer, project, and a table.

    Return (token, project_id, service_key).
    """
    token = signup_and_get_token(client, email="pause-test@example.com")
    project = create_project(client, token, name="pause-test")
    project_id = project["id"]
    api_keys = project["api_keys"]
    svc_key = next(k["key"] for k in api_keys if k["role"] == "service")

    # Create a table via service key
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": "notes",
            "columns": [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
            ],
        },
        headers={"apikey": svc_key},
    )
    assert resp.status_code == 201
    return token, project_id, svc_key


class TestPausedProjectRejectsCrud:
    """Paused projects must return 403 with PROJECT_PAUSED on CRUD requests."""

    def test_paused_project_rejects_insert_via_api_key(
        self, client: TestClient
    ) -> None:
        token, project_id, svc_key = _setup_project_with_table(client)

        # Pause the project
        resp = client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200

        # Attempt CRUD — should get 403
        resp = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "blocked"}]},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 403
        detail = resp.json()["detail"]
        assert detail["error"]["code"] == "PROJECT_PAUSED"
        assert "paused" in detail["error"]["message"].lower()

    def test_paused_project_rejects_select_via_api_key(
        self, client: TestClient
    ) -> None:
        token, project_id, svc_key = _setup_project_with_table(client)

        client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )

        resp = client.post(
            "/v1/db/notes/select",
            json={},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"]["code"] == "PROJECT_PAUSED"

    def test_paused_project_rejects_via_developer_jwt(self, client: TestClient) -> None:
        """Developer JWT + x-project-id path also checks project status."""
        token, project_id, svc_key = _setup_project_with_table(client)

        client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )

        # Use developer JWT + x-project-id instead of API key
        resp = client.post(
            "/v1/db/notes/select",
            json={},
            headers={
                "Authorization": f"Bearer {token}",
                "x-project-id": project_id,
            },
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"]["code"] == "PROJECT_PAUSED"

    def test_error_response_matches_spec(self, client: TestClient) -> None:
        token, project_id, svc_key = _setup_project_with_table(client)

        client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )

        resp = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "test"}]},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == {
            "error": {
                "code": "PROJECT_PAUSED",
                "message": "Project is paused. Restore it to resume access.",
            }
        }


class TestRestoredProjectAllowsCrud:
    """Restored projects must allow CRUD requests again."""

    def test_restore_then_insert_succeeds(self, client: TestClient) -> None:
        token, project_id, svc_key = _setup_project_with_table(client)

        # Pause
        resp = client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200

        # Verify blocked
        resp = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "blocked"}]},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 403

        # Restore
        resp = client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200

        # Verify CRUD works again
        resp = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "allowed"}]},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 201
        assert resp.json()["data"][0]["title"] == "allowed"

    def test_restore_then_select_succeeds(self, client: TestClient) -> None:
        token, project_id, svc_key = _setup_project_with_table(client)

        # Pause and restore
        client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )

        resp = client.post(
            "/v1/db/notes/select",
            json={},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 200


class TestManagementEndpointsWorkWhenPaused:
    """Pause/restore management endpoints use developer JWT, not API key middleware.

    They must still work when a project is paused.
    """

    def test_pause_endpoint_works_on_active_project(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="mgmt1@example.com")
        project = create_project(client, token, name="mgmt-test-1")

        resp = client.post(
            f"/v1/projects/{project['id']}/pause",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "paused"

    def test_restore_endpoint_works_on_paused_project(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="mgmt2@example.com")
        project = create_project(client, token, name="mgmt-test-2")

        # Pause first
        client.post(
            f"/v1/projects/{project['id']}/pause",
            headers=auth_headers(token),
        )

        # Restore works
        resp = client.post(
            f"/v1/projects/{project['id']}/restore",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "active"

    def test_get_project_works_when_paused(self, client: TestClient) -> None:
        """Developer can still GET project details when paused."""
        token = signup_and_get_token(client, email="mgmt3@example.com")
        project = create_project(client, token, name="mgmt-test-3")

        client.post(
            f"/v1/projects/{project['id']}/pause",
            headers=auth_headers(token),
        )

        resp = client.get(
            f"/v1/projects/{project['id']}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "paused"

    def test_list_projects_shows_paused(self, client: TestClient) -> None:
        """Paused projects appear in the project list (not archived)."""
        token = signup_and_get_token(client, email="mgmt4@example.com")
        project = create_project(client, token, name="mgmt-test-4")

        client.post(
            f"/v1/projects/{project['id']}/pause",
            headers=auth_headers(token),
        )

        resp = client.get(
            "/v1/projects",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        project_ids = [p["id"] for p in resp.json()]
        assert project["id"] in project_ids


class TestFullPauseRestoreCycle:
    """End-to-end: create -> CRUD -> pause -> reject -> restore -> CRUD."""

    def test_full_lifecycle(self, client: TestClient) -> None:
        token, project_id, svc_key = _setup_project_with_table(client)

        # 1. CRUD works on active project
        resp = client.post(
            "/v1/db/notes/insert",
            json={"rows": [{"title": "before pause"}]},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 201

        # 2. Pause
        resp = client.post(
            f"/v1/projects/{project_id}/pause",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200

        # 3. CRUD blocked
        resp = client.post(
            "/v1/db/notes/select",
            json={},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"]["code"] == "PROJECT_PAUSED"

        # 4. Restore
        resp = client.post(
            f"/v1/projects/{project_id}/restore",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200

        # 5. CRUD works again
        resp = client.post(
            "/v1/db/notes/select",
            json={},
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 200
        assert len(resp.json()["data"]) == 1
        assert resp.json()["data"][0]["title"] == "before pause"
