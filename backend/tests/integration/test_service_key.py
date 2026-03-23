"""Integration tests for POST /v1/projects/{id}/keys/service-key.

This endpoint generates a new service API key for Dashboard use
and returns the full key. Requires developer JWT authentication.
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


class TestServiceKeyRouteExists:
    """Verify the route is registered and returns non-404."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/keys/service-key")
        assert resp.status_code != 404


class TestServiceKeyAuth:
    """Endpoint requires valid JWT."""

    def test_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/keys/service-key")
        assert resp.status_code in (401, 403)


class TestServiceKeyGeneration:
    """POST /v1/projects/{id}/keys/service-key generates a usable service key."""

    def test_returns_full_service_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/service-key",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "key" in data
        assert "key_prefix" in data
        assert "role" in data
        assert data["role"] == "service"
        assert data["key"].startswith("pqdb_service_")

    def test_key_has_correct_format(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/service-key",
            headers=auth_headers(token),
        )
        data = resp.json()
        key = data["key"]
        parts = key.split("_", 2)
        assert len(parts) == 3
        assert parts[0] == "pqdb"
        assert parts[1] == "service"
        assert len(parts[2]) == 32

    def test_key_prefix_matches(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/service-key",
            headers=auth_headers(token),
        )
        data = resp.json()
        assert data["key_prefix"] == data["key"][:8]

    def test_nonexistent_project_returns_404(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/keys/service-key",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_other_developers_project_returns_404(self, client: TestClient) -> None:
        token_a = signup_and_get_token(client, email="svckey_a@test.com")
        token_b = signup_and_get_token(client, email="svckey_b@test.com")
        project = create_project(client, token_a, name="svckey-private")
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/keys/service-key",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404

    def test_new_key_appears_in_key_list(self, client: TestClient) -> None:
        """The generated key should appear when listing keys."""
        token = signup_and_get_token(client, email="svckey_list@test.com")
        project = create_project(client, token)
        project_id = project["id"]

        # Initially 2 keys (anon + service from project creation)
        list_resp1 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert len(list_resp1.json()) == 2

        # Generate a new service key (additive — doesn't delete existing)
        client.post(
            f"/v1/projects/{project_id}/keys/service-key",
            headers=auth_headers(token),
        )

        # Now 3 keys — original anon + original service + new service
        list_resp2 = client.get(
            f"/v1/projects/{project_id}/keys",
            headers=auth_headers(token),
        )
        assert len(list_resp2.json()) == 3

    def test_generated_key_is_unique_each_call(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="svckey_uniq@test.com")
        project = create_project(client, token)
        project_id = project["id"]

        resp1 = client.post(
            f"/v1/projects/{project_id}/keys/service-key",
            headers=auth_headers(token),
        )
        resp2 = client.post(
            f"/v1/projects/{project_id}/keys/service-key",
            headers=auth_headers(token),
        )
        assert resp1.json()["key"] != resp2.json()["key"]
