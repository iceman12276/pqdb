"""Integration tests for project-scoped request routing (US-009).

Boots the real FastAPI app with a real Postgres database,
exercises API key middleware validation and project context resolution.
"""

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
    app = _make_platform_app(test_db_url, include_db_router=True)
    with TestClient(app) as c:
        yield c


def _create_project_and_get_keys(
    client: TestClient, token: str, name: str = "test-project"
) -> tuple[str, list[dict[str, str]]]:
    """Create a project and return (project_id, api_keys)."""
    resp = client.post(
        "/v1/projects",
        json={"name": name},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    return data["id"], data["api_keys"]


class TestDbHealthRouteExists:
    """Verify /v1/db/health route is registered."""

    def test_db_health_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.status_code != 404


class TestApiKeyMissing:
    """Missing apikey header returns 401."""

    def test_missing_apikey_returns_401(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.status_code == 401

    def test_missing_apikey_error_message(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.json()["detail"] == "Missing apikey or Authorization header"


class TestApiKeyInvalid:
    """Invalid apikey header returns 403."""

    def test_malformed_key_returns_403(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/db/health",
            headers={"apikey": "not_a_valid_key"},
        )
        assert resp.status_code == 403

    def test_nonexistent_key_returns_403(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/db/health",
            headers={"apikey": "pqdb_anon_aaaabbbbccccddddeeeeffffggg0"},
        )
        assert resp.status_code == 403

    def test_wrong_key_value_returns_403(self, client: TestClient) -> None:
        """Valid format but no matching hash in the database."""
        token = signup_and_get_token(client, email="wrong@test.com")
        _create_project_and_get_keys(client, token, name="wrong-key-project")
        resp = client.get(
            "/v1/db/health",
            headers={"apikey": "pqdb_anon_aaaabbbbccccddddeeeeffffggg0"},
        )
        assert resp.status_code == 403


class TestApiKeyValid:
    """Valid apikey resolves project context."""

    def test_valid_anon_key_returns_200(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="anon@test.com")
        project_id, keys = _create_project_and_get_keys(client, token, name="anon-proj")
        anon_key = next(k["key"] for k in keys if k["role"] == "anon")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": anon_key},
        )
        assert resp.status_code == 200

    def test_valid_service_key_returns_200(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="svc@test.com")
        project_id, keys = _create_project_and_get_keys(client, token, name="svc-proj")
        svc_key = next(k["key"] for k in keys if k["role"] == "service")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": svc_key},
        )
        assert resp.status_code == 200

    def test_response_contains_project_id(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="pid@test.com")
        project_id, keys = _create_project_and_get_keys(client, token, name="pid-proj")
        anon_key = next(k["key"] for k in keys if k["role"] == "anon")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": anon_key},
        )
        data = resp.json()
        assert data["project_id"] == project_id

    def test_response_contains_role(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="role@test.com")
        _project_id, keys = _create_project_and_get_keys(
            client, token, name="role-proj"
        )
        anon_key = next(k["key"] for k in keys if k["role"] == "anon")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": anon_key},
        )
        data = resp.json()
        assert data["role"] == "anon"

    def test_service_role_reflected_in_response(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="svcr@test.com")
        _project_id, keys = _create_project_and_get_keys(
            client, token, name="svcr-proj"
        )
        svc_key = next(k["key"] for k in keys if k["role"] == "service")

        resp = client.get(
            "/v1/db/health",
            headers={"apikey": svc_key},
        )
        data = resp.json()
        assert data["role"] == "service"


class TestProjectIsolation:
    """Different API keys route to different projects."""

    def test_different_projects_return_different_ids(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="iso@test.com")
        pid_a, keys_a = _create_project_and_get_keys(client, token, name="proj-a")
        pid_b, keys_b = _create_project_and_get_keys(client, token, name="proj-b")

        key_a = next(k["key"] for k in keys_a if k["role"] == "anon")
        key_b = next(k["key"] for k in keys_b if k["role"] == "anon")

        resp_a = client.get("/v1/db/health", headers={"apikey": key_a})
        resp_b = client.get("/v1/db/health", headers={"apikey": key_b})

        assert resp_a.json()["project_id"] == pid_a
        assert resp_b.json()["project_id"] == pid_b
        assert pid_a != pid_b


class TestRotatedKeysWork:
    """After key rotation, old keys are invalid and new keys work."""

    def test_rotated_key_works(self, client: TestClient) -> None:
        token = signup_and_get_token(client, email="rot@test.com")
        project_id, old_keys = _create_project_and_get_keys(
            client, token, name="rot-proj"
        )
        old_anon = next(k["key"] for k in old_keys if k["role"] == "anon")

        # Rotate
        rotate_resp = client.post(
            f"/v1/projects/{project_id}/keys/rotate",
            headers=auth_headers(token),
        )
        assert rotate_resp.status_code == 200
        new_keys = rotate_resp.json()
        new_anon = next(k["key"] for k in new_keys if k["role"] == "anon")

        # Old key should fail
        resp_old = client.get("/v1/db/health", headers={"apikey": old_anon})
        assert resp_old.status_code == 403

        # New key should work
        resp_new = client.get("/v1/db/health", headers={"apikey": new_anon})
        assert resp_new.status_code == 200
        assert resp_new.json()["project_id"] == project_id


class TestPlatformHealthUnaffected:
    """Platform health check still works with db routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
