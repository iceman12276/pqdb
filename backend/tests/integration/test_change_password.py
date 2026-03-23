"""Integration tests for POST /v1/auth/change-password endpoint.

Tests the following acceptance criteria:
- Verifies old password, rejects wrong password with 401
- Updates password hash, new login works with new password
- Returns new token pair
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
    app = _make_platform_app(test_db_url)
    with TestClient(app) as c:
        yield c


class TestChangePassword:
    """Tests for POST /v1/auth/change-password."""

    def test_change_password_success(self, client: TestClient) -> None:
        """Change password, then login with new password works."""
        token = signup_and_get_token(client, email="chgpw@test.com")
        resp = client.post(
            "/v1/auth/change-password",
            json={"current_password": "testpass123", "new_password": "newpass456"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"

        # Login with new password should succeed
        login_resp = client.post(
            "/v1/auth/login",
            json={"email": "chgpw@test.com", "password": "newpass456"},
        )
        assert login_resp.status_code == 200

    def test_change_password_old_password_stops_working(
        self, client: TestClient
    ) -> None:
        """After changing password, old password no longer works."""
        token = signup_and_get_token(client, email="oldpw@test.com")
        client.post(
            "/v1/auth/change-password",
            json={"current_password": "testpass123", "new_password": "newpass456"},
            headers=auth_headers(token),
        )

        # Login with old password should fail
        login_resp = client.post(
            "/v1/auth/login",
            json={"email": "oldpw@test.com", "password": "testpass123"},
        )
        assert login_resp.status_code == 401

    def test_change_password_wrong_current_returns_401(
        self, client: TestClient
    ) -> None:
        """Wrong current_password returns 401."""
        token = signup_and_get_token(client, email="wrongpw@test.com")
        resp = client.post(
            "/v1/auth/change-password",
            json={"current_password": "wrong-password", "new_password": "newpass456"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 401

    def test_change_password_returns_new_tokens(self, client: TestClient) -> None:
        """Returned tokens are valid (can be used to access protected resources)."""
        token = signup_and_get_token(client, email="tokens@test.com")
        resp = client.post(
            "/v1/auth/change-password",
            json={"current_password": "testpass123", "new_password": "newpass456"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        new_token = resp.json()["access_token"]

        # New token should work for authenticated endpoints
        projects_resp = client.get(
            "/v1/projects",
            headers=auth_headers(new_token),
        )
        assert projects_resp.status_code == 200

    def test_change_password_requires_auth(self, client: TestClient) -> None:
        """Endpoint requires JWT auth."""
        resp = client.post(
            "/v1/auth/change-password",
            json={"current_password": "testpass123", "new_password": "newpass456"},
        )
        assert resp.status_code in (401, 403)
