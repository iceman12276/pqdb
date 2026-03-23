"""Integration tests for scoped API key endpoints.

Boots the real FastAPI app with a real Postgres database,
exercises scoped key creation, listing with permissions, and deletion.
"""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import (
    _make_platform_app,
    auth_headers,
    create_project,
    signup_and_get_token,
)


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_platform_app(test_db_url)
    with TestClient(app) as c:
        yield c


class TestScopedKeyRoutesExist:
    """Verify scoped key routes are registered and return non-404."""

    def test_create_scoped_key_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/keys/scoped",
            json={"name": "test", "permissions": {"tables": {"t": ["select"]}}},
        )
        assert resp.status_code != 404

    def test_delete_key_route_exists(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}/keys/{uuid.uuid4()}")
        assert resp.status_code != 404


class TestScopedKeyAuth:
    """Scoped key endpoints require valid JWT."""

    def test_create_scoped_key_without_auth_returns_401_or_403(
        self, client: TestClient
    ) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/keys/scoped",
            json={"name": "test", "permissions": {"tables": {"t": ["select"]}}},
        )
        assert resp.status_code in (401, 403)

    def test_delete_key_without_auth_returns_401_or_403(
        self, client: TestClient
    ) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}/keys/{uuid.uuid4()}")
        assert resp.status_code in (401, 403)


class TestCreateScopedKey:
    """Tests for POST /v1/projects/{project_id}/keys/scoped."""

    def test_create_scoped_key_returns_201(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="scoped1@test.com")
        project = create_project(client, token, name="scoped-proj-1")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "read-only-key",
                "permissions": {"tables": {"users": ["select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 201

    def test_create_scoped_key_returns_correct_format(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="scoped2@test.com")
        project = create_project(client, token, name="scoped-proj-2")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "my-key",
                "permissions": {"tables": {"posts": ["select", "insert"]}},
            },
            headers=auth_headers(token),
        )
        data = resp.json()
        assert data["role"] == "scoped"
        assert data["name"] == "my-key"
        assert data["key"].startswith("pqdb_scoped_")
        assert data["key_prefix"] == data["key"][:8]
        assert data["permissions"] == {"tables": {"posts": ["select", "insert"]}}
        assert "id" in data

    def test_create_scoped_key_with_all_operations(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="scoped3@test.com")
        project = create_project(client, token, name="scoped-proj-3")
        project_id = project["id"]

        perms = {
            "tables": {
                "users": ["select", "insert", "update", "delete"],
                "posts": ["select"],
            }
        }
        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={"name": "admin-key", "permissions": perms},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        assert resp.json()["permissions"] == perms

    def test_create_scoped_key_for_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client, email="scoped4@test.com")
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/keys/scoped",
            json={
                "name": "key",
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_create_scoped_key_for_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = signup_and_get_token(client, email="scoped5a@test.com")
        token_b = signup_and_get_token(client, email="scoped5b@test.com")
        project = create_project(client, token_a, name="scoped-proj-5")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "sneaky",
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestScopedKeyNameValidation:
    """Tests that invalid name values return 422."""

    def test_empty_name_returns_422(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="name1@test.com")
        project = create_project(client, token, name="name-proj-1")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "",
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_whitespace_only_name_returns_422(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="name2@test.com")
        project = create_project(client, token, name="name-proj-2")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "   ",
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_too_long_name_returns_422(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="name3@test.com")
        project = create_project(client, token, name="name-proj-3")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "x" * 256,
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_name_with_leading_trailing_whitespace_is_stripped(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client, email="name4@test.com")
        project = create_project(client, token, name="name-proj-4")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "  my-key  ",
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        assert resp.json()["name"] == "my-key"


class TestScopedKeyPermissionsValidation:
    """Tests that invalid permissions schema returns 422."""

    def test_invalid_missing_tables_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="val1@test.com")
        project = create_project(client, token, name="val-proj-1")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "bad-key",
                "permissions": {"wrong": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_invalid_unknown_operation(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="val2@test.com")
        project = create_project(client, token, name="val-proj-2")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "bad-key",
                "permissions": {"tables": {"users": ["select", "drop"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_invalid_empty_tables(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="val3@test.com")
        project = create_project(client, token, name="val-proj-3")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "bad-key",
                "permissions": {"tables": {}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_invalid_empty_operations(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="val4@test.com")
        project = create_project(client, token, name="val-proj-4")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "bad-key",
                "permissions": {"tables": {"users": []}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_invalid_duplicate_operations(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="val5@test.com")
        project = create_project(client, token, name="val-proj-5")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "bad-key",
                "permissions": {"tables": {"users": ["select", "select"]}},
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422


class TestListKeysWithPermissions:
    """Tests that GET /v1/projects/{id}/keys returns permissions for each key."""

    def test_list_includes_scoped_key_permissions(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="list1@test.com")
        project = create_project(client, token, name="list-proj-1")
        project_id = project["id"]

        perms = {"tables": {"users": ["select"]}}
        client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={"name": "read-key", "permissions": perms},
            headers=auth_headers(token),
        )

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        keys = resp.json()
        # 2 default keys (anon, service) + 1 scoped
        assert len(keys) == 3

        scoped_keys = [k for k in keys if k["role"] == "scoped"]
        assert len(scoped_keys) == 1
        assert scoped_keys[0]["name"] == "read-key"
        assert scoped_keys[0]["permissions"] == perms

    def test_list_shows_null_permissions_for_non_scoped_keys(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client, email="list2@test.com")
        project = create_project(client, token, name="list-proj-2")
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        keys = resp.json()
        for key in keys:
            assert key["permissions"] is None
            assert key["name"] is None


class TestDeleteKey:
    """Tests for DELETE /v1/projects/{project_id}/keys/{key_id}."""

    def test_delete_scoped_key_returns_204(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="del1@test.com")
        project = create_project(client, token, name="del-proj-1")
        project_id = project["id"]

        create_resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "temp-key",
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        key_id = create_resp.json()["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}/keys/{key_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 204

    def test_delete_key_actually_removes_it(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="del2@test.com")
        project = create_project(client, token, name="del-proj-2")
        project_id = project["id"]

        create_resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={
                "name": "doomed-key",
                "permissions": {"tables": {"t": ["select"]}},
            },
            headers=auth_headers(token),
        )
        key_id = create_resp.json()["id"]

        client.delete(
            f"/v1/projects/{project_id}/keys/{key_id}",
            headers=auth_headers(token),
        )

        list_resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        key_ids = {k["id"] for k in list_resp.json()}
        assert key_id not in key_ids

    def test_delete_nonexistent_key_returns_404(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="del3@test.com")
        project = create_project(client, token, name="del-proj-3")
        project_id = project["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}/keys/{uuid.uuid4()}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_delete_key_for_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = signup_and_get_token(client, email="del4a@test.com")
        token_b = signup_and_get_token(client, email="del4b@test.com")
        project = create_project(client, token_a, name="del-proj-4")
        project_id = project["id"]

        # Get one of the default key ids
        list_resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token_a),
        )
        key_id = list_resp.json()[0]["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}/keys/{key_id}",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404

    def test_delete_anon_key_returns_404(self, client: TestClient) -> None:
        """DELETE should only allow deleting scoped keys, not anon keys."""
        token = signup_and_get_token(client, email="del-anon@test.com")
        project = create_project(client, token, name="del-anon-proj")
        project_id = project["id"]

        list_resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        anon_key = next(k for k in list_resp.json() if k["role"] == "anon")

        resp = client.delete(
            f"/v1/projects/{project_id}/keys/{anon_key['id']}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_delete_service_key_returns_404(self, client: TestClient) -> None:
        """DELETE should only allow deleting scoped keys, not service keys."""
        token = signup_and_get_token(client, email="del-svc@test.com")
        project = create_project(client, token, name="del-svc-proj")
        project_id = project["id"]

        list_resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        svc_key = next(k for k in list_resp.json() if k["role"] == "service")

        resp = client.delete(
            f"/v1/projects/{project_id}/keys/{svc_key['id']}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestHealthCheck:
    """Health check still works with scoped key routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200


class TestFullScopedKeyFlow:
    """End-to-end: signup -> create project -> create scoped key -> list -> delete."""

    def test_complete_scoped_key_flow(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="flow-scoped@test.com")
        project = create_project(client, token, name="flow-scoped-proj")
        project_id = project["id"]

        # Create a scoped key
        perms = {"tables": {"users": ["select"], "posts": ["select", "insert"]}}
        create_resp = client.post(
            f"/v1/projects/{project_id}/keys/scoped",
            json={"name": "read-write-key", "permissions": perms},
            headers=auth_headers(token),
        )
        assert create_resp.status_code == 201
        scoped_key = create_resp.json()
        assert scoped_key["key"].startswith("pqdb_scoped_")
        assert scoped_key["name"] == "read-write-key"
        assert scoped_key["permissions"] == perms

        # List and verify scoped key appears with permissions
        list_resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert list_resp.status_code == 200
        keys = list_resp.json()
        assert len(keys) == 3  # anon + service + scoped

        scoped = [k for k in keys if k["role"] == "scoped"]
        assert len(scoped) == 1
        assert scoped[0]["permissions"] == perms
        assert scoped[0]["name"] == "read-write-key"
        # Full key should NOT be in list response
        assert "key" not in scoped[0]

        # Delete the scoped key
        delete_resp = client.delete(
            f"/v1/projects/{project_id}/keys/{scoped_key['id']}",
            headers=auth_headers(token),
        )
        assert delete_resp.status_code == 204

        # Verify deleted
        list_resp2 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert len(list_resp2.json()) == 2  # back to anon + service only
