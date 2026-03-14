"""Integration tests for API key endpoints.

Boots the real FastAPI app with a real Postgres database,
exercises key generation on project creation, listing, and rotation.
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


class TestApiKeyRoutesExist:
    """Verify all API key routes are registered and return non-404."""

    def test_list_keys_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/keys")
        assert resp.status_code != 404

    def test_rotate_keys_route_exists(self, client: TestClient) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/keys/rotate")
        assert resp.status_code != 404


class TestApiKeyAuth:
    """API key endpoints require valid JWT."""

    def test_list_keys_without_auth_returns_401_or_403(
        self, client: TestClient
    ) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/keys")
        assert resp.status_code in (401, 403)

    def test_rotate_keys_without_auth_returns_401_or_403(
        self, client: TestClient
    ) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/keys/rotate")
        assert resp.status_code in (401, 403)


class TestProjectCreationGeneratesKeys:
    """Creating a project should auto-generate API keys."""

    def test_create_project_returns_api_keys(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "keyed-project"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "api_keys" in data
        keys = data["api_keys"]
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}

    def test_created_keys_have_correct_format(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "format-project"},
            headers=auth_headers(token),
        )
        data = resp.json()
        for key_info in data["api_keys"]:
            full_key = key_info["key"]
            assert full_key.startswith(f"pqdb_{key_info['role']}_")
            parts = full_key.split("_", 2)
            assert len(parts[2]) == 32

    def test_created_keys_show_prefix(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "prefix-project"},
            headers=auth_headers(token),
        )
        data = resp.json()
        for key_info in data["api_keys"]:
            assert "key_prefix" in key_info
            assert len(key_info["key_prefix"]) == 8


class TestListKeys:
    """Tests for GET /v1/projects/{project_id}/keys."""

    def test_list_keys_for_project(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        keys = resp.json()
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}

    def test_list_keys_does_not_expose_full_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        keys = resp.json()
        for key in keys:
            assert "key" not in key
            assert "key_hash" not in key
            assert "key_prefix" in key

    def test_list_keys_for_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}/keys",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_list_keys_for_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = signup_and_get_token(client, email="keya@test.com")
        token_b = signup_and_get_token(client, email="keyb@test.com")

        project = create_project(client, token_a, name="private-keys")
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestRotateKeys:
    """Tests for POST /v1/projects/{project_id}/keys/rotate."""

    def test_rotate_keys_returns_new_keys(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        keys = resp.json()
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}
        for key_info in keys:
            assert "key" in key_info
            assert key_info["key"].startswith(f"pqdb_{key_info['role']}_")

    def test_rotate_keys_invalidates_old_keys(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        list_resp1 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        old_ids = {k["id"] for k in list_resp1.json()}

        client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=auth_headers(token),
        )

        list_resp2 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        new_ids = {k["id"] for k in list_resp2.json()}
        assert old_ids != new_ids

    def test_rotate_keys_for_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/keys/rotate",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_rotate_keys_for_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = signup_and_get_token(client, email="rota@test.com")
        token_b = signup_and_get_token(client, email="rotb@test.com")

        project = create_project(client, token_a, name="rotate-private")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestHealthCheck:
    """Health check still works with API key routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200


class TestFullApiKeyFlow:
    """End-to-end: signup -> create -> list keys -> rotate."""

    def test_complete_api_key_flow(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="flow@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "flow-project"},
            headers=auth_headers(token),
        )
        assert create_resp.status_code == 201
        project = create_resp.json()
        project_id = project["id"]

        assert len(project["api_keys"]) == 2
        original_keys = {k["key"] for k in project["api_keys"]}
        assert len(original_keys) == 2

        list_resp = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert list_resp.status_code == 200
        listed_keys = list_resp.json()
        assert len(listed_keys) == 2
        for k in listed_keys:
            assert "key" not in k
            assert "key_prefix" in k

        rotate_resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=auth_headers(token),
        )
        assert rotate_resp.status_code == 200
        new_keys = {k["key"] for k in rotate_resp.json()}
        assert len(new_keys) == 2
        assert new_keys != original_keys

        list_resp2 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert len(list_resp2.json()) == 2
