"""Integration tests for Vault HMAC key management.

Boots the real FastAPI app with a real Postgres database, mocked provisioner,
and mock VaultClient. Exercises HMAC key storage on project creation and
retrieval via endpoint.
"""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from pqdb_api.services.rate_limiter import RateLimiter
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


class TestHmacKeyRouteExists:
    """Verify the HMAC key endpoint is registered."""

    def test_hmac_key_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/hmac-key")
        assert resp.status_code != 404


class TestHmacKeyAuth:
    """HMAC key endpoint requires valid JWT."""

    def test_hmac_key_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/hmac-key")
        assert resp.status_code in (401, 403)


class TestHmacKeyStoredOnProjectCreation:
    """HMAC key is generated and stored in Vault when a project is created."""

    def test_create_project_stores_hmac_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "hmac-project"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        project_id = resp.json()["id"]

        # HMAC key should be retrievable
        hmac_resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        assert hmac_resp.status_code == 200
        data = hmac_resp.json()
        assert "hmac_key" in data
        # Key should be 256-bit (32 bytes = 64 hex chars)
        assert len(data["hmac_key"]) == 64


class TestGetHmacKey:
    """Tests for GET /v1/projects/{id}/hmac-key."""

    def test_get_hmac_key_returns_key(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "key-project"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "hmac_key" in data
        assert isinstance(data["hmac_key"], str)

    def test_get_hmac_key_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}/hmac-key",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_get_hmac_key_other_developer_returns_404(self, client: TestClient) -> None:
        token_a = signup_and_get_token(client, email="owner@test.com")
        token_b = signup_and_get_token(client, email="intruder@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "private-hmac"},
            headers=auth_headers(token_a),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token_b),
        )
        assert resp.status_code == 404

    def test_get_hmac_key_consistent_across_requests(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "consistent-key"},
            headers=auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp1 = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        resp2 = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        assert resp1.json()["hmac_key"] == resp2.json()["hmac_key"]


class TestHmacKeyRateLimiting:
    """HMAC key endpoint is rate-limited per project."""

    def test_rate_limit_returns_429(self, test_db_url: str) -> None:
        """After 10 requests, the 11th should return 429."""
        app = _make_platform_app(test_db_url)
        with TestClient(app) as client:
            token = signup_and_get_token(client)
            create_resp = client.post(
                "/v1/projects",
                json={"name": "rate-limit-project"},
                headers=auth_headers(token),
            )
            project_id = create_resp.json()["id"]

            # Override rate limiter with a very low limit
            app.state.hmac_rate_limiter = RateLimiter(max_requests=2, window_seconds=60)

            # First 2 should succeed
            for _ in range(2):
                resp = client.get(
                    f"/v1/projects/{project_id}/hmac-key",
                    headers=auth_headers(token),
                )
                assert resp.status_code == 200

            # 3rd should be rate limited
            resp = client.get(
                f"/v1/projects/{project_id}/hmac-key",
                headers=auth_headers(token),
            )
            assert resp.status_code == 429
