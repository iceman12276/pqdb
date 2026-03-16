"""Integration tests for email verification (US-032).

Tests the full flow:
- Signup fires webhook when magic_link_webhook configured
- POST /v1/auth/users/verify-email validates and consumes token
- POST /v1/auth/users/resend-verification generates new token + webhook
- CRUD enforcement: unverified users blocked when require_email_verification=true
- Single-use tokens (reuse returns 400)
- Expired tokens return 400
- Service responds to health check
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
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
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.auth_settings import router as auth_settings_router
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.auth_engine import ensure_auth_tables
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient
from pqdb_api.services.webhook import (
    generate_verification_token,
    hash_verification_token,
)


# ---------------------------------------------------------------------------
# Mock webhook server to capture dispatched webhooks
# ---------------------------------------------------------------------------
class WebhookCapture:
    """Captures webhook payloads sent during tests."""

    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []
        self._server: HTTPServer | None = None
        self._thread: Thread | None = None

    def start(self) -> str:
        """Start a mock HTTP server. Returns the URL."""
        capture = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                payload = json.loads(body)
                capture.payloads.append(payload)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK")

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        port = self._server.server_address[1]
        self._thread = Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return f"http://127.0.0.1:{port}/webhook"

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()


# ---------------------------------------------------------------------------
# App factory for email verification tests
# ---------------------------------------------------------------------------
def _make_email_verification_app(
    test_db_url: str,
    test_db_name: str,
    webhook_url: str | None = None,
) -> FastAPI:
    """Build a test FastAPI app for email verification integration tests.

    Includes user_auth router (signup, verify, resend) and db router (CRUD).
    Uses a fake project context that points to the test database.
    """
    from pqdb_api.routes.api_keys import router as api_keys_router

    private_key, public_key = generate_ed25519_keypair()

    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return test_db_name

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    stored_keys: dict[str, bytes] = {}
    mock_vault = MagicMock(spec=VaultClient)

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

        # Pre-configure webhook URL and verification settings if provided
        if webhook_url:
            async with project_factory() as session:
                await ensure_auth_tables(session)
                await session.execute(
                    text(
                        "UPDATE _pqdb_auth_settings "
                        "SET magic_link_webhook = :url, "
                        "require_email_verification = true "
                        "WHERE id = 1"
                    ),
                    {"url": webhook_url},
                )
                await session.commit()

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
    app.include_router(auth_settings_router)
    app.include_router(db_router)
    return app


@pytest.fixture()
def webhook_capture() -> Iterator[WebhookCapture]:
    """Provide a mock webhook server that captures payloads."""
    capture = WebhookCapture()
    yield capture
    capture.stop()


@pytest.fixture()
def client_with_webhook(
    test_db_url: str,
    test_db_name: str,
    webhook_capture: WebhookCapture,
) -> Iterator[TestClient]:
    """TestClient with webhook configured and require_email_verification=true."""
    webhook_url = webhook_capture.start()
    app = _make_email_verification_app(test_db_url, test_db_name, webhook_url)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def client_no_webhook(
    test_db_url: str,
    test_db_name: str,
) -> Iterator[TestClient]:
    """TestClient without webhook configured."""
    app = _make_email_verification_app(test_db_url, test_db_name)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def project_db_session(
    test_db_url: str,
) -> async_sessionmaker[AsyncSession]:
    engine = create_async_engine(test_db_url)
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestHealthCheck:
    """Health check works with email verification routes."""

    def test_health_returns_200(self, client_no_webhook: TestClient) -> None:
        resp = client_no_webhook.get("/health")
        assert resp.status_code == 200


class TestVerifyEmailRouteExists:
    """Verify the new routes are registered."""

    def test_verify_email_route_exists(self, client_no_webhook: TestClient) -> None:
        resp = client_no_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": "fake-token"},
        )
        assert resp.status_code != 404

    def test_resend_verification_route_exists(
        self, client_no_webhook: TestClient
    ) -> None:
        resp = client_no_webhook.post(
            "/v1/auth/users/resend-verification",
            json={"email": "test@example.com"},
        )
        assert resp.status_code != 404


class TestSignupFiresWebhook:
    """On signup, if magic_link_webhook is configured, server fires webhook."""

    def test_signup_dispatches_email_verification_webhook(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
    ) -> None:
        resp = client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "verify@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 201

        # Webhook should have been fired
        assert len(webhook_capture.payloads) == 1
        payload = webhook_capture.payloads[0]
        assert payload["type"] == "email_verification"
        assert payload["to"] == "verify@example.com"
        assert "token" in payload
        assert payload["expires_in"] == 86400

    def test_signup_without_webhook_does_not_fire(
        self, client_no_webhook: TestClient
    ) -> None:
        resp = client_no_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "nowebhook@example.com", "password": "securepass123"},
        )
        assert resp.status_code == 201
        # No error = webhook was not attempted (it's not configured)


class TestVerifyEmail:
    """POST /v1/auth/users/verify-email flow."""

    def test_verify_valid_token(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
    ) -> None:
        """Signup → get token from webhook → verify → email_verified=true."""
        # Signup
        signup_resp = client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "verify_flow@example.com", "password": "securepass123"},
        )
        assert signup_resp.status_code == 201
        access_token = signup_resp.json()["access_token"]

        # Get token from webhook
        assert len(webhook_capture.payloads) == 1
        verification_token = webhook_capture.payloads[0]["token"]

        # Verify email
        verify_resp = client_with_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": verification_token},
        )
        assert verify_resp.status_code == 200
        assert verify_resp.json()["message"] == "Email verified successfully"

        # Check user profile shows email_verified=true
        me_resp = client_with_webhook.get(
            "/v1/auth/users/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert me_resp.status_code == 200
        assert me_resp.json()["email_verified"] is True

    def test_verify_invalid_token_returns_400(
        self, client_no_webhook: TestClient
    ) -> None:
        resp = client_no_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": "completely-invalid-token"},
        )
        assert resp.status_code == 400
        error = resp.json()["detail"]["error"]
        assert error["code"] == "invalid_token"

    def test_verify_token_single_use(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
    ) -> None:
        """Using a consumed token returns 400."""
        # Signup
        client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "singleuse@example.com", "password": "securepass123"},
        )
        token = webhook_capture.payloads[0]["token"]

        # First use: success
        resp1 = client_with_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": token},
        )
        assert resp1.status_code == 200

        # Second use: should fail
        resp2 = client_with_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": token},
        )
        assert resp2.status_code == 400
        error = resp2.json()["detail"]["error"]
        assert error["code"] == "token_already_used"

    def test_verify_expired_token_returns_400(
        self,
        client_with_webhook: TestClient,
        project_db_session: async_sessionmaker[AsyncSession],
    ) -> None:
        """Expired tokens return 400 with clear message."""
        import asyncio

        # Signup to create user
        signup_resp = client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "expired@example.com", "password": "securepass123"},
        )
        user_id = signup_resp.json()["user"]["id"]

        # Insert an expired token directly into the DB
        expired_token = generate_verification_token()
        token_hash = hash_verification_token(expired_token)

        async def _insert_expired() -> None:
            async with project_db_session() as session:
                await ensure_auth_tables(session)
                await session.execute(
                    text(
                        "INSERT INTO _pqdb_verification_tokens "
                        "(id, user_id, email, token_hash, type, expires_at) "
                        "VALUES (:id, :uid, :email, :hash, :type, :expires_at)"
                    ),
                    {
                        "id": str(uuid.uuid4()),
                        "uid": user_id,
                        "email": "expired@example.com",
                        "hash": token_hash,
                        "type": "email_verification",
                        "expires_at": datetime.now(UTC) - timedelta(hours=1),
                    },
                )
                await session.commit()

        loop = asyncio.new_event_loop()
        loop.run_until_complete(_insert_expired())
        loop.close()

        resp = client_with_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": expired_token},
        )
        assert resp.status_code == 400
        error = resp.json()["detail"]["error"]
        assert error["code"] == "token_expired"


class TestResendVerification:
    """POST /v1/auth/users/resend-verification flow."""

    def test_resend_fires_webhook(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
    ) -> None:
        """Signup → resend → new webhook fired."""
        # Signup
        client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "resend@example.com", "password": "securepass123"},
        )
        assert len(webhook_capture.payloads) == 1  # From signup

        # Resend
        resp = client_with_webhook.post(
            "/v1/auth/users/resend-verification",
            json={"email": "resend@example.com"},
        )
        assert resp.status_code == 200
        assert len(webhook_capture.payloads) == 2  # New webhook fired

        # New token in webhook
        new_payload = webhook_capture.payloads[1]
        assert new_payload["type"] == "email_verification"
        assert new_payload["to"] == "resend@example.com"

    def test_resend_nonexistent_email_returns_success(
        self, client_with_webhook: TestClient
    ) -> None:
        """Returns success to prevent email enumeration."""
        resp = client_with_webhook.post(
            "/v1/auth/users/resend-verification",
            json={"email": "nobody@example.com"},
        )
        assert resp.status_code == 200

    def test_resend_rate_limited(self, client_with_webhook: TestClient) -> None:
        """3 per minute per email."""
        # Signup first
        client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "ratelimit@example.com", "password": "securepass123"},
        )

        # 3 resends should succeed
        for _ in range(3):
            resp = client_with_webhook.post(
                "/v1/auth/users/resend-verification",
                json={"email": "ratelimit@example.com"},
            )
            assert resp.status_code == 200

        # 4th should be rate limited
        resp = client_with_webhook.post(
            "/v1/auth/users/resend-verification",
            json={"email": "ratelimit@example.com"},
        )
        assert resp.status_code == 429

    def test_resend_without_webhook_configured_returns_400(
        self, client_no_webhook: TestClient
    ) -> None:
        resp = client_no_webhook.post(
            "/v1/auth/users/resend-verification",
            json={"email": "test@example.com"},
        )
        assert resp.status_code == 400
        assert "not configured" in resp.json()["detail"]


class TestCrudEnforcement:
    """CRUD operations blocked for unverified users when enforcement is on."""

    def _setup_table_and_user(
        self,
        client: TestClient,
        project_db_session: async_sessionmaker[AsyncSession],
    ) -> tuple[str, str]:
        """Create a table with owner column and a user.

        Returns (access_token, user_id).
        """
        import asyncio

        # Create table with owner column via db routes
        # First we need to create the _pqdb_columns metadata table and a test table
        async def _create_table() -> None:
            async with project_db_session() as session:
                from pqdb_api.services.schema_engine import ensure_metadata_table

                await ensure_metadata_table(session)
                # Create test table with owner column
                await session.execute(
                    text(
                        "CREATE TABLE IF NOT EXISTS test_items ("
                        "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
                        "  user_id uuid,"
                        "  name text,"
                        "  created_at timestamptz NOT NULL DEFAULT now(),"
                        "  updated_at timestamptz NOT NULL DEFAULT now()"
                        ")"
                    )
                )
                # Insert column metadata
                for col_name, sensitivity, data_type, is_owner in [
                    ("id", "plain", "uuid", False),
                    ("user_id", "plain", "uuid", True),
                    ("name", "plain", "text", False),
                ]:
                    await session.execute(
                        text(
                            "INSERT INTO _pqdb_columns "
                            "(table_name, column_name, "
                            "sensitivity, data_type, is_owner) "
                            "VALUES (:tbl, :col, :sens, "
                            ":dtype, :owner) "
                            "ON CONFLICT DO NOTHING"
                        ),
                        {
                            "tbl": "test_items",
                            "col": col_name,
                            "sens": sensitivity,
                            "dtype": data_type,
                            "owner": is_owner,
                        },
                    )
                await session.commit()

        loop = asyncio.new_event_loop()
        loop.run_until_complete(_create_table())
        loop.close()

        # Signup a user
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "cruduser@example.com", "password": "securepass123"},
        )
        assert signup_resp.status_code == 201
        access_token = signup_resp.json()["access_token"]
        user_id = signup_resp.json()["user"]["id"]
        return access_token, user_id

    def test_unverified_user_blocked_on_insert(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
        project_db_session: async_sessionmaker[AsyncSession],
    ) -> None:
        """Unverified user gets 403 on insert when enforcement is on."""
        access_token, user_id = self._setup_table_and_user(
            client_with_webhook, project_db_session
        )

        resp = client_with_webhook.post(
            "/v1/db/test_items/insert",
            json={"rows": [{"user_id": user_id, "name": "test"}]},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert resp.status_code == 403
        error = resp.json()["detail"]["error"]
        assert error["code"] == "email_not_verified"

    def test_unverified_user_blocked_on_select(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
        project_db_session: async_sessionmaker[AsyncSession],
    ) -> None:
        access_token, user_id = self._setup_table_and_user(
            client_with_webhook, project_db_session
        )

        resp = client_with_webhook.post(
            "/v1/db/test_items/select",
            json={"columns": ["*"]},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert resp.status_code == 403
        error = resp.json()["detail"]["error"]
        assert error["code"] == "email_not_verified"

    def test_verified_user_can_access_crud(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
        project_db_session: async_sessionmaker[AsyncSession],
    ) -> None:
        """Full flow: signup → verify → CRUD access granted."""
        access_token, user_id = self._setup_table_and_user(
            client_with_webhook, project_db_session
        )

        # Get verification token from webhook and verify
        # The webhook payloads include one from signup
        verification_token = webhook_capture.payloads[0]["token"]
        verify_resp = client_with_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": verification_token},
        )
        assert verify_resp.status_code == 200

        # Need a new access token since old one has email_verified=false
        # Login to get fresh token with email_verified=true
        login_resp = client_with_webhook.post(
            "/v1/auth/users/login",
            json={"email": "cruduser@example.com", "password": "securepass123"},
        )
        assert login_resp.status_code == 200
        new_token = login_resp.json()["access_token"]

        # Insert should now succeed
        insert_resp = client_with_webhook.post(
            "/v1/db/test_items/insert",
            json={"rows": [{"user_id": user_id, "name": "allowed"}]},
            headers={"Authorization": f"Bearer {new_token}"},
        )
        assert insert_resp.status_code == 201

        # Select should succeed
        select_resp = client_with_webhook.post(
            "/v1/db/test_items/select",
            json={"columns": ["*"]},
            headers={"Authorization": f"Bearer {new_token}"},
        )
        assert select_resp.status_code == 200
        assert len(select_resp.json()["data"]) >= 1


class TestFullEmailVerificationFlow:
    """End-to-end: signup → webhook → verify → email_verified → CRUD."""

    def test_complete_flow(
        self,
        client_with_webhook: TestClient,
        webhook_capture: WebhookCapture,
    ) -> None:
        """Complete email verification lifecycle."""
        # 1. Signup
        signup_resp = client_with_webhook.post(
            "/v1/auth/users/signup",
            json={"email": "fullflow@example.com", "password": "securepass123"},
        )
        assert signup_resp.status_code == 201
        assert signup_resp.json()["user"]["email_verified"] is False

        # 2. Webhook was fired
        assert len(webhook_capture.payloads) == 1
        payload = webhook_capture.payloads[0]
        assert payload["type"] == "email_verification"
        assert payload["to"] == "fullflow@example.com"
        token = payload["token"]
        assert payload["expires_in"] == 86400

        # 3. Verify email
        verify_resp = client_with_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": token},
        )
        assert verify_resp.status_code == 200

        # 4. Login to get token with email_verified=true
        login_resp = client_with_webhook.post(
            "/v1/auth/users/login",
            json={"email": "fullflow@example.com", "password": "securepass123"},
        )
        assert login_resp.status_code == 200
        assert login_resp.json()["user"]["email_verified"] is True

        # 5. Reusing the token should fail
        reuse_resp = client_with_webhook.post(
            "/v1/auth/users/verify-email",
            json={"token": token},
        )
        assert reuse_resp.status_code == 400
        assert reuse_resp.json()["detail"]["error"]["code"] == "token_already_used"
