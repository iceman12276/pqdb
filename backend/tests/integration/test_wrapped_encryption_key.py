"""Integration tests for wrapped encryption key API endpoints.

Tests the following acceptance criteria:
- POST /v1/projects accepts optional wrapped_encryption_key (base64 string)
- GET /v1/projects and GET /v1/projects/{id} return wrapped_encryption_key
- PATCH /v1/projects/{id}/encryption-key updates the wrapped blob
"""

import base64
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


# A fake 32-byte wrapped key for testing
_FAKE_WRAPPED_KEY = base64.b64encode(b"wrapped-key-bytes-1234567890ab").decode()
_UPDATED_WRAPPED_KEY = base64.b64encode(b"updated-wrapped-key-bytes-xxxxx").decode()


class TestCreateProjectWithWrappedKey:
    """Tests for POST /v1/projects with wrapped_encryption_key."""

    def test_create_project_with_wrapped_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "key-project", "wrapped_encryption_key": _FAKE_WRAPPED_KEY},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["wrapped_encryption_key"] == _FAKE_WRAPPED_KEY

    def test_create_project_without_wrapped_key(self, client: TestClient) -> None:
        """Backward compatibility: omitting wrapped_encryption_key returns null."""
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "no-key-project"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["wrapped_encryption_key"] is None


class TestGetProjectReturnsWrappedKey:
    """Tests for GET /v1/projects/{id} with wrapped_encryption_key."""

    def test_get_project_returns_wrapped_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={
                "name": "get-key-project",
                "wrapped_encryption_key": _FAKE_WRAPPED_KEY,
            },
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["wrapped_encryption_key"] == _FAKE_WRAPPED_KEY

    def test_get_project_returns_null_when_no_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "no-key-get"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["wrapped_encryption_key"] is None


class TestListProjectsReturnsWrappedKey:
    """Tests for GET /v1/projects with wrapped_encryption_key."""

    def test_list_projects_returns_wrapped_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        client.post(
            "/v1/projects",
            json={
                "name": "list-key-project",
                "wrapped_encryption_key": _FAKE_WRAPPED_KEY,
            },
            headers=auth_headers(token),
        )

        resp = client.get("/v1/projects", headers=auth_headers(token))
        assert resp.status_code == 200
        projects = resp.json()
        assert len(projects) == 1
        assert projects[0]["wrapped_encryption_key"] == _FAKE_WRAPPED_KEY


class TestPatchWrappedKey:
    """Tests for PATCH /v1/projects/{id}/encryption-key."""

    def test_patch_wrapped_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "patch-project", "wrapped_encryption_key": _FAKE_WRAPPED_KEY},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.patch(
            f"/v1/projects/{project_id}/encryption-key",
            json={"wrapped_encryption_key": _UPDATED_WRAPPED_KEY},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["wrapped_encryption_key"] == _UPDATED_WRAPPED_KEY

        # Verify via GET
        get_resp = client.get(
            f"/v1/projects/{project_id}",
            headers=auth_headers(token),
        )
        assert get_resp.json()["wrapped_encryption_key"] == _UPDATED_WRAPPED_KEY

    def test_patch_key_on_project_without_key(self, client: TestClient) -> None:
        """Can set a key on a project that was created without one."""
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "no-key-then-patch"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.patch(
            f"/v1/projects/{project_id}/encryption-key",
            json={"wrapped_encryption_key": _FAKE_WRAPPED_KEY},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["wrapped_encryption_key"] == _FAKE_WRAPPED_KEY

    def test_patch_key_requires_auth(self, client: TestClient) -> None:
        resp = client.patch(
            "/v1/projects/00000000-0000-0000-0000-000000000000/encryption-key",
            json={"wrapped_encryption_key": _FAKE_WRAPPED_KEY},
        )
        assert resp.status_code in (401, 403)

    def test_patch_key_wrong_developer_returns_404(self, client: TestClient) -> None:
        token_a = signup_and_get_token(client, email="owner-patch@test.com")
        token_b = signup_and_get_token(client, email="intruder-patch@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "owned-project"},
            headers=auth_headers(token_a),
        )
        project_id = create_resp.json()["id"]

        resp = client.patch(
            f"/v1/projects/{project_id}/encryption-key",
            json={"wrapped_encryption_key": _FAKE_WRAPPED_KEY},
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestInvalidBase64Validation:
    """Tests for invalid base64 handling on wrapped_encryption_key."""

    def test_create_project_invalid_base64_returns_422(
        self, client: TestClient
    ) -> None:
        """POST /v1/projects with malformed base64 returns 422."""
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={
                "name": "bad-key-project",
                "wrapped_encryption_key": "not!valid!base64%%",
            },
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_patch_invalid_base64_returns_422(self, client: TestClient) -> None:
        """PATCH with malformed base64 returns 422."""
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "patch-bad-key"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.patch(
            f"/v1/projects/{project_id}/encryption-key",
            json={"wrapped_encryption_key": "not!valid!base64%%"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 422
