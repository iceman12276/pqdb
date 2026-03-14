"""Integration tests for project CRUD endpoints.

Boots the real FastAPI app with a real Postgres database,
exercises create -> list -> get -> delete project flow with auth.
The provisioner is mocked to avoid needing a real Postgres superuser.
"""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import (
    _make_platform_app,
    auth_headers,
    signup_and_get_token,
)


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_platform_app(test_db_url)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def client_with_provisioner_failure(test_db_url: str) -> Iterator[TestClient]:
    from pqdb_api.services.provisioner import ProvisioningError

    app = _make_platform_app(
        test_db_url,
        provisioner_side_effect=ProvisioningError("Connection refused"),
    )
    with TestClient(app) as c:
        yield c


class TestProjectRoutesExist:
    """Verify all project routes are registered and return non-404."""

    def test_create_project_route_exists(self, client: TestClient) -> None:
        resp = client.post("/v1/projects", json={"name": "test"})
        assert resp.status_code != 404

    def test_list_projects_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/projects")
        assert resp.status_code != 404

    def test_get_project_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code != 404

    def test_delete_project_route_exists(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code != 404


class TestProjectAuth:
    """All project endpoints require valid JWT."""

    def test_create_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.post("/v1/projects", json={"name": "test"})
        assert resp.status_code in (401, 403)

    def test_list_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get("/v1/projects")
        assert resp.status_code in (401, 403)

    def test_get_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code in (401, 403)

    def test_delete_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code in (401, 403)


class TestCreateProject:
    """Tests for POST /v1/projects."""

    def test_create_project_success(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "my-project"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "my-project"
        assert data["region"] == "us-east-1"
        assert data["status"] == "active"
        assert "id" in data
        assert "created_at" in data

    def test_create_project_sets_database_name(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "db-project"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["database_name"] is not None
        assert data["database_name"].startswith("pqdb_project_")

    def test_create_project_with_region(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "eu-project", "region": "eu-west-1"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        assert resp.json()["region"] == "eu-west-1"

    def test_create_project_missing_name_returns_422(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={},
            headers=auth_headers(token),
        )
        assert resp.status_code == 422


class TestCreateProjectProvisioningFailure:
    """Tests for project creation when provisioning fails."""

    def test_provisioning_failure_sets_status(
        self, client_with_provisioner_failure: TestClient
    ) -> None:
        token = signup_and_get_token(client_with_provisioner_failure)
        resp = client_with_provisioner_failure.post(
            "/v1/projects",
            json={"name": "fail-project"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "provisioning_failed"
        assert data["database_name"] is None


class TestListProjects:
    """Tests for GET /v1/projects."""

    def test_list_projects_empty(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.get("/v1/projects", headers=auth_headers(token))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_projects_returns_own_projects(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        client.post(
            "/v1/projects",
            json={"name": "proj-1"},
            headers=auth_headers(token),
        )
        client.post(
            "/v1/projects",
            json={"name": "proj-2"},
            headers=auth_headers(token),
        )
        resp = client.get("/v1/projects", headers=auth_headers(token))
        assert resp.status_code == 200
        projects = resp.json()
        assert len(projects) == 2
        names = {p["name"] for p in projects}
        assert names == {"proj-1", "proj-2"}

    def test_list_projects_includes_database_name(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        client.post(
            "/v1/projects",
            json={"name": "listed-project"},
            headers=auth_headers(token),
        )
        resp = client.get("/v1/projects", headers=auth_headers(token))
        assert resp.status_code == 200
        projects = resp.json()
        assert len(projects) == 1
        assert projects[0]["database_name"] is not None
        assert projects[0]["database_name"].startswith("pqdb_project_")

    def test_list_projects_does_not_include_other_developers(
        self, client: TestClient
    ) -> None:
        token_a = signup_and_get_token(client, email="dev-a@test.com")
        token_b = signup_and_get_token(client, email="dev-b@test.com")

        client.post(
            "/v1/projects",
            json={"name": "a-project"},
            headers=auth_headers(token_a),
        )
        client.post(
            "/v1/projects",
            json={"name": "b-project"},
            headers=auth_headers(token_b),
        )

        resp_a = client.get("/v1/projects", headers=auth_headers(token_a))
        assert resp_a.status_code == 200
        assert len(resp_a.json()) == 1
        assert resp_a.json()[0]["name"] == "a-project"

    def test_list_projects_excludes_archived(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "to-archive"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        # Delete (archive) the project
        client.delete(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )

        resp = client.get("/v1/projects", headers=auth_headers(token))
        assert resp.status_code == 200
        assert len(resp.json()) == 0


class TestGetProject:
    """Tests for GET /v1/projects/{id}."""

    def test_get_project_success(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "detail-project"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == project_id
        assert data["name"] == "detail-project"

    def test_get_project_includes_database_name(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "db-detail-project"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["database_name"] is not None

    def test_get_nonexistent_project_returns_404(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_get_other_developers_project_returns_404(self, client: TestClient) -> None:
        token_a = signup_and_get_token(client, email="owner@test.com")
        token_b = signup_and_get_token(client, email="intruder@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "private-project"},
            headers=auth_headers(token_a),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestDeleteProject:
    """Tests for DELETE /v1/projects/{id}."""

    def test_delete_project_success(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "to-delete"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "archived"

    def test_delete_project_is_soft_delete(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "soft-delete"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        client.delete(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )

        # Project should still be retrievable by ID (just archived)
        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "archived"

    def test_delete_does_not_clear_database_name(self, client: TestClient) -> None:
        """Deleting a project does NOT drop the database (soft delete for MVP)."""
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "keep-db"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]
        db_name = create_resp.json()["database_name"]

        client.delete(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["database_name"] == db_name

    def test_delete_nonexistent_project_returns_404(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.delete(
            f"/v1/projects/{uuid.uuid4()}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_delete_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = signup_and_get_token(client, email="delowner@test.com")
        token_b = signup_and_get_token(client, email="delintruder@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "not-yours"},
            headers=auth_headers(token_a),
        )
        project_id = create_resp.json()["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestHealthCheck:
    """Health check still works with project routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200


class TestFullProjectFlow:
    """End-to-end: signup -> create project -> list -> get -> delete."""

    def test_complete_crud_flow(self, client: TestClient) -> None:
        # 1. Sign up
        token = signup_and_get_token(client, email="crud@test.com")

        # 2. Create project
        create_resp = client.post(
            "/v1/projects",
            json={"name": "flow-project", "region": "ap-southeast-1"},
            headers=auth_headers(token),
        )
        assert create_resp.status_code == 201
        project = create_resp.json()
        project_id = project["id"]
        assert project["name"] == "flow-project"
        assert project["region"] == "ap-southeast-1"
        assert project["status"] == "active"
        assert project["database_name"] is not None
        assert project["database_name"].startswith("pqdb_project_")

        # 3. List projects - should include the new one
        list_resp = client.get("/v1/projects", headers=auth_headers(token))
        assert list_resp.status_code == 200
        assert len(list_resp.json()) == 1

        # 4. Get project by ID
        get_resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert get_resp.status_code == 200
        assert get_resp.json()["name"] == "flow-project"

        # 5. Delete (archive) project
        del_resp = client.delete(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert del_resp.status_code == 200
        assert del_resp.json()["status"] == "archived"

        # 6. List should now be empty (archived projects excluded)
        list_resp2 = client.get("/v1/projects", headers=auth_headers(token))
        assert list_resp2.status_code == 200
        assert len(list_resp2.json()) == 0

        # 7. Get by ID still returns (with archived status)
        get_resp2 = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert get_resp2.status_code == 200
        assert get_resp2.json()["status"] == "archived"
        # Database name preserved (soft delete doesn't drop the DB)
        assert get_resp2.json()["database_name"] is not None
