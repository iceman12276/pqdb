"""Integration tests for magic link authentication (US-034).

Boots the real FastAPI app with real Postgres, tests the full flow:
- POST /v1/auth/users/magic-link: request a magic link
- POST /v1/auth/users/verify-magic-link: verify the token
- Webhook fires on magic link request
- New user created if not exists (password_hash = NULL)
- Existing user reuses account
- Single-use token enforcement
- Rate limiting: 5/min per email
- 400 if magic_link_webhook not configured
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.config import Settings
from pqdb_api.database import get_session
from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_mldsa65_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _make_magic_link_app(
    test_db_url: str,
    test_db_name: str,
    *,
    webhook_url: str | None = "https://example.com/webhook",
) -> tuple[FastAPI, MagicMock]:
    """Build a test FastAPI app for magic link integration tests.

    Returns (app, mock_webhook_dispatcher) so tests can inspect webhook calls.
    """
    private_key, public_key = generate_mldsa65_keypair()

    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return test_db_name

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    mock_vault = MagicMock(spec=VaultClient)
    stored_keys: dict[str, bytes] = {}

    def _mock_store(project_id: uuid.UUID, key: bytes) -> None:
        stored_keys[str(project_id)] = key

    def _mock_get(project_id: uuid.UUID) -> bytes:
        key = stored_keys.get(str(project_id))
        if key is None:
            from pqdb_api.services.vault import VaultError

            raise VaultError("Key not found")
        return key

    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store)
    mock_vault.get_hmac_key = MagicMock(side_effect=_mock_get)

    settings = Settings(
        database_url=test_db_url,
        superuser_dsn="postgresql://test:test@localhost/test",
    )

    fake_project_id = uuid.uuid4()
    fake_context = ProjectContext(
        project_id=fake_project_id,
        key_role="anon",
        database_name=test_db_name,
    )

    # We'll track webhook URL in a mutable container so tests can override
    webhook_config = {"url": webhook_url}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        platform_engine = create_async_engine(test_db_url)
        platform_factory = async_sessionmaker(
            platform_engine, class_=AsyncSession, expire_on_commit=False
        )

        project_engine = create_async_engine(test_db_url)
        project_factory = async_sessionmaker(
            project_engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with platform_factory() as session:
                yield session

        async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
            async with project_factory() as session:
                yield session

        async def _override_get_project_context() -> ProjectContext:
            return fake_context

        app.dependency_overrides[get_session] = _override_get_session
        app.dependency_overrides[get_project_session] = _override_get_project_session
        app.dependency_overrides[get_project_context] = _override_get_project_context
        app.state.mldsa65_private_key = private_key
        app.state.mldsa65_public_key = public_key
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        app.state.settings = settings
        yield
        await platform_engine.dispose()
        await project_engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(user_auth_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)

    # Store webhook config on app for the endpoints to read
    app.state._test_webhook_config = webhook_config

    return app, MagicMock()


def _configure_webhook(client: TestClient, url: str | None) -> None:
    """Configure the magic_link_webhook in auth settings via SQL.

    We need to set the webhook URL in _pqdb_auth_settings so the
    magic link endpoint can find it.
    """
    # Use the auth settings endpoint if available, or set directly
    # For now, we'll use a direct approach via the test DB
    pass


@pytest.fixture()
def client_with_webhook(test_db_url: str, test_db_name: str) -> Iterator[TestClient]:
    """Client with magic_link_webhook configured."""
    app, _ = _make_magic_link_app(test_db_url, test_db_name)
    with TestClient(app) as c:
        # Configure webhook via auth settings
        # First, trigger table creation by making any auth request
        c.post(
            "/v1/auth/users/signup",
            json={"email": "setup@test.com", "password": "setuppass123"},
        )
        # Now set the webhook URL directly in the DB
        import subprocess

        subprocess.run(
            [
                "psql",
                "-h",
                "localhost",
                "-p",
                "5432",
                "-U",
                "postgres",
                "-d",
                test_db_name,
                "-c",
                "UPDATE _pqdb_auth_settings "
                "SET magic_link_webhook = "
                "'https://example.com/webhook' "
                "WHERE id = 1",
            ],
            env={"PGPASSWORD": "postgres"},
            check=True,
            capture_output=True,
        )
        yield c


@pytest.fixture()
def client_no_webhook(test_db_url: str, test_db_name: str) -> Iterator[TestClient]:
    """Client without magic_link_webhook configured."""
    app, _ = _make_magic_link_app(test_db_url, test_db_name, webhook_url=None)
    with TestClient(app) as c:
        yield c


class TestMagicLinkRoutesExist:
    """Verify magic link routes are registered and don't 404."""

    def test_magic_link_route_exists(self, client_with_webhook: TestClient) -> None:
        resp = client_with_webhook.post(
            "/v1/auth/users/magic-link",
            json={"email": "route@test.com"},
        )
        assert resp.status_code != 404

    def test_verify_magic_link_route_exists(
        self, client_with_webhook: TestClient
    ) -> None:
        resp = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": "fake-token"},
        )
        assert resp.status_code != 404


class TestMagicLinkRequest:
    """Tests for POST /v1/auth/users/magic-link."""

    def test_magic_link_new_user_returns_200(
        self, client_with_webhook: TestClient
    ) -> None:
        """New user gets created, token stored, webhook dispatched."""
        with patch("pqdb_api.routes.user_auth.WebhookDispatcher") as MockDispatcher:
            mock_instance = AsyncMock()
            MockDispatcher.return_value = mock_instance

            resp = client_with_webhook.post(
                "/v1/auth/users/magic-link",
                json={"email": "newuser@example.com"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["message"] == "Magic link sent"

            # Webhook should have been dispatched
            mock_instance.dispatch.assert_called_once()
            call_kwargs = mock_instance.dispatch.call_args[1]
            assert call_kwargs["event_type"] == "magic_link"
            assert call_kwargs["email"] == "newuser@example.com"
            assert call_kwargs["expires_in"] == 900  # 15 minutes

    def test_magic_link_existing_user_returns_200(
        self, client_with_webhook: TestClient
    ) -> None:
        """Existing user reuses account, just gets a new magic link token."""
        # First, sign up a user with password
        client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "existing@example.com", "password": "securepass123"},
        )

        with patch("pqdb_api.routes.user_auth.WebhookDispatcher") as MockDispatcher:
            mock_instance = AsyncMock()
            MockDispatcher.return_value = mock_instance

            resp = client_with_webhook.post(
                "/v1/auth/users/magic-link",
                json={"email": "existing@example.com"},
            )
            assert resp.status_code == 200
            assert resp.json()["message"] == "Magic link sent"

    def test_magic_link_without_webhook_returns_400(
        self, client_no_webhook: TestClient
    ) -> None:
        """Returns 400 if magic_link_webhook is not configured."""
        resp = client_no_webhook.post(
            "/v1/auth/users/magic-link",
            json={"email": "nowebhook@example.com"},
        )
        assert resp.status_code == 400
        assert "webhook" in resp.json()["detail"].lower()

    def test_magic_link_invalid_email_returns_422(
        self, client_with_webhook: TestClient
    ) -> None:
        resp = client_with_webhook.post(
            "/v1/auth/users/magic-link",
            json={"email": "not-an-email"},
        )
        assert resp.status_code == 422

    def test_magic_link_rate_limit_5_per_minute(
        self, client_with_webhook: TestClient
    ) -> None:
        """5 magic link requests/min per email, then 429."""
        with patch("pqdb_api.routes.user_auth.WebhookDispatcher") as MockDispatcher:
            mock_instance = AsyncMock()
            MockDispatcher.return_value = mock_instance

            for i in range(5):
                resp = client_with_webhook.post(
                    "/v1/auth/users/magic-link",
                    json={"email": "ratelimit@example.com"},
                )
                assert resp.status_code == 200, f"Request {i + 1} failed: {resp.json()}"

            # 6th should be rate limited
            resp = client_with_webhook.post(
                "/v1/auth/users/magic-link",
                json={"email": "ratelimit@example.com"},
            )
            assert resp.status_code == 429


class TestVerifyMagicLink:
    """Tests for POST /v1/auth/users/verify-magic-link."""

    def _request_magic_link(self, client: TestClient, email: str) -> str:
        """Request a magic link and return the plaintext token.

        We patch WebhookDispatcher to capture the token from the
        dispatched webhook payload.
        """
        captured_token: list[str] = []

        with patch("pqdb_api.routes.user_auth.WebhookDispatcher") as MockDispatcher:
            mock_instance = AsyncMock()
            MockDispatcher.return_value = mock_instance

            async def _capture_dispatch(**kwargs: Any) -> None:
                captured_token.append(kwargs["token"])

            mock_instance.dispatch = AsyncMock(side_effect=_capture_dispatch)

            resp = client.post(
                "/v1/auth/users/magic-link",
                json={"email": email},
            )
            assert resp.status_code == 200

        assert len(captured_token) == 1, "Token was not captured from webhook"
        return captured_token[0]

    def test_verify_magic_link_returns_user_and_tokens(
        self, client_with_webhook: TestClient
    ) -> None:
        """Successful verification returns user profile + JWT tokens."""
        token = self._request_magic_link(client_with_webhook, "verify@example.com")

        resp = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": token},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "user" in data
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["user"]["email"] == "verify@example.com"
        assert data["user"]["email_verified"] is True
        assert data["user"]["role"] == "authenticated"

    def test_verify_sets_email_verified_true(
        self, client_with_webhook: TestClient
    ) -> None:
        """After verification, email_verified should be True."""
        token = self._request_magic_link(client_with_webhook, "emailverify@example.com")

        resp = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": token},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["user"]["email_verified"] is True

        # Use the access token to check /me
        access_token = data["access_token"]
        me_resp = client_with_webhook.get(
            "/v1/auth/users/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert me_resp.status_code == 200
        assert me_resp.json()["email_verified"] is True

    def test_verify_single_use_token(self, client_with_webhook: TestClient) -> None:
        """Token can only be used once — second verify returns 400."""
        token = self._request_magic_link(client_with_webhook, "singleuse@example.com")

        # First verify succeeds
        resp1 = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": token},
        )
        assert resp1.status_code == 200

        # Second verify fails
        resp2 = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": token},
        )
        assert resp2.status_code == 400

    def test_verify_invalid_token_returns_400(
        self, client_with_webhook: TestClient
    ) -> None:
        resp = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": "completely-fake-token"},
        )
        assert resp.status_code == 400

    def test_verify_creates_session(self, client_with_webhook: TestClient) -> None:
        """Verification creates a session — refresh token works."""
        token = self._request_magic_link(client_with_webhook, "session@example.com")

        resp = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": token},
        )
        assert resp.status_code == 200
        refresh_token = resp.json()["refresh_token"]

        # Refresh should work
        refresh_resp = client_with_webhook.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": refresh_token},
        )
        assert refresh_resp.status_code == 200
        assert "access_token" in refresh_resp.json()


class TestMagicLinkFullFlow:
    """End-to-end: magic-link request -> verify -> authenticated with JWT."""

    def test_full_magic_link_flow(self, client_with_webhook: TestClient) -> None:
        """Full flow: request magic link -> verify -> use JWT to access /me."""
        captured_token: list[str] = []

        with patch("pqdb_api.routes.user_auth.WebhookDispatcher") as MockDispatcher:
            mock_instance = AsyncMock()
            MockDispatcher.return_value = mock_instance

            async def _capture(**kwargs: Any) -> None:
                captured_token.append(kwargs["token"])

            mock_instance.dispatch = AsyncMock(side_effect=_capture)

            # 1. Request magic link
            resp = client_with_webhook.post(
                "/v1/auth/users/magic-link",
                json={"email": "flow@example.com"},
            )
            assert resp.status_code == 200

        # 2. Verify magic link
        verify_resp = client_with_webhook.post(
            "/v1/auth/users/verify-magic-link",
            json={"token": captured_token[0]},
        )
        assert verify_resp.status_code == 200
        data = verify_resp.json()
        assert data["user"]["email"] == "flow@example.com"
        assert data["user"]["email_verified"] is True

        # 3. Use access token to access /me
        access_token = data["access_token"]
        me_resp = client_with_webhook.get(
            "/v1/auth/users/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert me_resp.status_code == 200
        assert me_resp.json()["email"] == "flow@example.com"

        # 4. Logout (revoke refresh token)
        refresh_token = data["refresh_token"]
        logout_resp = client_with_webhook.post(
            "/v1/auth/users/logout",
            json={"refresh_token": refresh_token},
        )
        assert logout_resp.status_code == 200

        # 5. Refresh should now fail
        refresh_resp = client_with_webhook.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": refresh_token},
        )
        assert refresh_resp.status_code == 401


class TestHealthCheck:
    """Health check still works with magic link routes."""

    def test_health_returns_200(self, client_with_webhook: TestClient) -> None:
        resp = client_with_webhook.get("/health")
        assert resp.status_code == 200
