"""Integration tests for password reset (US-033).

Boots the real FastAPI app with real Postgres, tests the full flow:
reset-password, webhook fires, update-password, old sessions
revoked, new login works.

All endpoints use apikey header for project resolution.
"""

from __future__ import annotations

import subprocess
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
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient
from pqdb_api.services.webhook import WebhookDispatcher

# Reuse PG connection params from conftest
PG_USER = "postgres"
PG_PASS = "postgres"
PG_HOST = "localhost"
PG_PORT = 5432


def _set_webhook_url(test_db_name: str) -> None:
    """Set the magic_link_webhook in _pqdb_auth_settings via psql.

    This must be called AFTER ensure_auth_tables has created the settings row
    (i.e., after a signup or any auth endpoint call).
    """
    subprocess.run(
        [
            "psql",
            "-h",
            PG_HOST,
            "-p",
            str(PG_PORT),
            "-U",
            PG_USER,
            "-d",
            test_db_name,
            "-c",
            "UPDATE _pqdb_auth_settings "
            "SET magic_link_webhook = 'https://hooks.example.com/test' "
            "WHERE id = 1",
        ],
        env={"PGPASSWORD": PG_PASS},
        check=True,
        capture_output=True,
    )


def _make_password_reset_app(
    test_db_url: str, test_db_name: str
) -> tuple[FastAPI, MagicMock]:
    """Build a test FastAPI app for password reset integration tests.

    Returns (app, mock_webhook_dispatcher) so tests can inspect webhook calls.
    """
    private_key, public_key = generate_ed25519_keypair()

    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    mock_vault = MagicMock(spec=VaultClient)

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

    # Mock webhook dispatcher to capture calls
    mock_webhook = AsyncMock(spec=WebhookDispatcher)
    mock_webhook.dispatch = AsyncMock()

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
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
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
    return app, mock_webhook


@pytest.fixture()
def app_and_webhook(test_db_url: str, test_db_name: str) -> tuple[FastAPI, MagicMock]:
    return _make_password_reset_app(test_db_url, test_db_name)


@pytest.fixture()
def client(app_and_webhook: tuple[FastAPI, MagicMock]) -> Iterator[TestClient]:
    app, _ = app_and_webhook
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def mock_webhook(app_and_webhook: tuple[FastAPI, MagicMock]) -> MagicMock:
    _, webhook = app_and_webhook
    return webhook


def _signup_user(client: TestClient, email: str, password: str) -> dict[str, Any]:
    """Helper: sign up a user and return response data."""
    resp = client.post(
        "/v1/auth/users/signup",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 201, f"Signup failed: {resp.json()}"
    data: dict[str, Any] = resp.json()
    return data


def _signup_and_configure_webhook(
    client: TestClient, test_db_name: str, email: str, password: str
) -> dict[str, Any]:
    """Signup a user, then configure the webhook URL in auth settings."""
    data: dict[str, Any] = _signup_user(client, email, password)
    _set_webhook_url(test_db_name)
    return data


def _login_user(client: TestClient, email: str, password: str) -> dict[str, Any]:
    """Helper: login and return response data."""
    resp = client.post(
        "/v1/auth/users/login",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, f"Login failed: {resp.json()}"
    data: dict[str, Any] = resp.json()
    return data


class TestPasswordResetRoutesExist:
    """Verify password reset routes are registered and don't 404."""

    def test_reset_password_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/reset-password",
            json={"email": "test@example.com"},
        )
        assert resp.status_code != 404

    def test_update_password_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/update-password",
            json={"token": "fake", "new_password": "newpass123"},
        )
        assert resp.status_code != 404


class TestResetPassword:
    """Tests for POST /v1/auth/users/reset-password."""

    def test_reset_password_returns_200_for_existing_user(
        self,
        client: TestClient,
        mock_webhook: MagicMock,
        test_db_name: str,
    ) -> None:
        _signup_and_configure_webhook(
            client, test_db_name, "reset@example.com", "securepass123"
        )

        with patch(
            "pqdb_api.routes.user_auth.WebhookDispatcher", return_value=mock_webhook
        ):
            resp = client.post(
                "/v1/auth/users/reset-password",
                json={"email": "reset@example.com"},
            )
        assert resp.status_code == 200

    def test_reset_password_returns_200_for_nonexistent_email(
        self, client: TestClient, test_db_name: str
    ) -> None:
        """Prevents email enumeration — always returns 200.

        We need to trigger table creation first, then set webhook URL.
        """
        # Signup a dummy user to trigger table creation
        _signup_and_configure_webhook(
            client, test_db_name, "dummy@example.com", "securepass123"
        )

        resp = client.post(
            "/v1/auth/users/reset-password",
            json={"email": "nonexistent@example.com"},
        )
        assert resp.status_code == 200

    def test_reset_password_fires_webhook(
        self,
        client: TestClient,
        mock_webhook: MagicMock,
        test_db_name: str,
    ) -> None:
        _signup_and_configure_webhook(
            client, test_db_name, "webhook@example.com", "securepass123"
        )

        with patch(
            "pqdb_api.routes.user_auth.WebhookDispatcher", return_value=mock_webhook
        ):
            resp = client.post(
                "/v1/auth/users/reset-password",
                json={"email": "webhook@example.com"},
            )
        assert resp.status_code == 200
        # Webhook should have been dispatched
        mock_webhook.dispatch.assert_called_once()
        call_kwargs = mock_webhook.dispatch.call_args.kwargs
        assert call_kwargs["event_type"] == "password_reset"
        assert call_kwargs["email"] == "webhook@example.com"
        assert "token" in call_kwargs
        assert call_kwargs["expires_in"] == 3600  # 1 hour

    def test_reset_password_rate_limited(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        """5 requests/min per email."""
        # Need tables + webhook configured for the first requests to go through
        _signup_and_configure_webhook(
            client, test_db_name, "ratelimit_user@example.com", "securepass123"
        )

        email = "ratelimit@example.com"
        with patch(
            "pqdb_api.routes.user_auth.WebhookDispatcher", return_value=mock_webhook
        ):
            for _ in range(5):
                client.post(
                    "/v1/auth/users/reset-password",
                    json={"email": email},
                )

        resp = client.post(
            "/v1/auth/users/reset-password",
            json={"email": email},
        )
        assert resp.status_code == 429

    def test_reset_password_returns_400_without_webhook_configured(
        self, client: TestClient
    ) -> None:
        """If no webhook URL configured, returns 400."""
        _signup_user(client, "nowh@example.com", "securepass123")

        resp = client.post(
            "/v1/auth/users/reset-password",
            json={"email": "nowh@example.com"},
        )
        assert resp.status_code == 400


class TestUpdatePassword:
    """Tests for POST /v1/auth/users/update-password."""

    def _do_reset_and_get_token(
        self, client: TestClient, mock_webhook: MagicMock, email: str
    ) -> str:
        """Helper: trigger password reset and extract the token from webhook call."""
        with patch(
            "pqdb_api.routes.user_auth.WebhookDispatcher", return_value=mock_webhook
        ):
            resp = client.post(
                "/v1/auth/users/reset-password",
                json={"email": email},
            )
        assert resp.status_code == 200, f"Reset failed: {resp.json()}"
        call_kwargs = mock_webhook.dispatch.call_args.kwargs
        token: str = call_kwargs["token"]
        return token

    def test_update_password_success(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        _signup_and_configure_webhook(
            client, test_db_name, "update@example.com", "oldpassword123"
        )

        token = self._do_reset_and_get_token(client, mock_webhook, "update@example.com")

        resp = client.post(
            "/v1/auth/users/update-password",
            json={"token": token, "new_password": "newpassword123"},
        )
        assert resp.status_code == 200

    def test_update_password_allows_login_with_new_password(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        _signup_and_configure_webhook(
            client, test_db_name, "newpw@example.com", "oldpassword123"
        )

        token = self._do_reset_and_get_token(client, mock_webhook, "newpw@example.com")

        client.post(
            "/v1/auth/users/update-password",
            json={"token": token, "new_password": "newpassword123"},
        )

        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": "newpw@example.com", "password": "newpassword123"},
        )
        assert login_resp.status_code == 200

    def test_update_password_rejects_old_password(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        _signup_and_configure_webhook(
            client, test_db_name, "oldpw@example.com", "oldpassword123"
        )

        token = self._do_reset_and_get_token(client, mock_webhook, "oldpw@example.com")

        client.post(
            "/v1/auth/users/update-password",
            json={"token": token, "new_password": "newpassword123"},
        )

        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": "oldpw@example.com", "password": "oldpassword123"},
        )
        assert login_resp.status_code == 401

    def test_update_password_invalidates_all_sessions(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        """All existing sessions should be revoked after password update."""
        signup_data = _signup_and_configure_webhook(
            client, test_db_name, "sessions@example.com", "oldpassword123"
        )
        refresh_token = signup_data["refresh_token"]

        token = self._do_reset_and_get_token(
            client, mock_webhook, "sessions@example.com"
        )

        client.post(
            "/v1/auth/users/update-password",
            json={"token": token, "new_password": "newpassword123"},
        )

        refresh_resp = client.post(
            "/v1/auth/users/refresh",
            json={"refresh_token": refresh_token},
        )
        assert refresh_resp.status_code == 401

    def test_update_password_token_single_use(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        """Token can only be used once."""
        _signup_and_configure_webhook(
            client, test_db_name, "singleuse@example.com", "oldpassword123"
        )

        token = self._do_reset_and_get_token(
            client, mock_webhook, "singleuse@example.com"
        )

        resp1 = client.post(
            "/v1/auth/users/update-password",
            json={"token": token, "new_password": "newpassword123"},
        )
        assert resp1.status_code == 200

        resp2 = client.post(
            "/v1/auth/users/update-password",
            json={"token": token, "new_password": "anotherpassword123"},
        )
        assert resp2.status_code == 400

    def test_update_password_invalid_token_returns_400(
        self, client: TestClient
    ) -> None:
        resp = client.post(
            "/v1/auth/users/update-password",
            json={"token": "invalid_token_here", "new_password": "newpass123"},
        )
        assert resp.status_code == 400

    def test_update_password_too_short_returns_400(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        _signup_and_configure_webhook(
            client, test_db_name, "shortpw@example.com", "oldpassword123"
        )

        token = self._do_reset_and_get_token(
            client, mock_webhook, "shortpw@example.com"
        )

        resp = client.post(
            "/v1/auth/users/update-password",
            json={"token": token, "new_password": "short"},
        )
        assert resp.status_code == 400


class TestFullPasswordResetFlow:
    """E2E: signup, login, reset, update, old sessions dead, new login."""

    def test_full_flow(
        self, client: TestClient, mock_webhook: MagicMock, test_db_name: str
    ) -> None:
        email = "fullflow@example.com"
        old_password = "oldpassword123"
        new_password = "newpassword123"

        # 1. Signup and configure webhook
        signup_data = _signup_and_configure_webhook(
            client, test_db_name, email, old_password
        )
        refresh_token_from_signup = signup_data["refresh_token"]

        # 2. Login to create a second session
        login_data = _login_user(client, email, old_password)
        refresh_token_from_login = login_data["refresh_token"]

        # 3. Request password reset
        with patch(
            "pqdb_api.routes.user_auth.WebhookDispatcher", return_value=mock_webhook
        ):
            reset_resp = client.post(
                "/v1/auth/users/reset-password",
                json={"email": email},
            )
        assert reset_resp.status_code == 200
        reset_token = mock_webhook.dispatch.call_args.kwargs["token"]

        # 4. Update password
        update_resp = client.post(
            "/v1/auth/users/update-password",
            json={"token": reset_token, "new_password": new_password},
        )
        assert update_resp.status_code == 200

        # 5. Old sessions should be dead
        for old_token in [refresh_token_from_signup, refresh_token_from_login]:
            resp = client.post(
                "/v1/auth/users/refresh",
                json={"refresh_token": old_token},
            )
            assert resp.status_code == 401

        # 6. Old password should not work
        bad_login = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": old_password},
        )
        assert bad_login.status_code == 401

        # 7. New password should work
        good_login = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": new_password},
        )
        assert good_login.status_code == 200
        assert "access_token" in good_login.json()


class TestHealthCheck:
    """Health check still works with password reset routes."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
