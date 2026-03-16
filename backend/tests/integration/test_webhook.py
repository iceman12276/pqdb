"""Integration tests for webhook dispatch (US-031).

Tests:
- Webhook dispatch with mock HTTP server
- Token storage and retrieval in _pqdb_verification_tokens
- HTTPS URL validation on auth settings update
- Health check still works
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
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
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.auth_settings import router as auth_settings_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.auth_engine import ensure_auth_tables
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient
from pqdb_api.services.webhook import (
    WebhookDispatcher,
    generate_verification_token,
    hash_verification_token,
    verify_verification_token,
)
from tests.integration.conftest import (
    auth_headers,
    create_project,
    signup_and_get_token,
)


def _make_webhook_test_app(test_db_url: str, test_db_name: str) -> FastAPI:
    """Build a test app for webhook-related tests."""
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

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_session] = _override_get_session
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        app.state.settings = settings
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    app.include_router(auth_settings_router)
    return app


@pytest.fixture()
def client(test_db_url: str, test_db_name: str) -> Iterator[TestClient]:
    app = _make_webhook_test_app(test_db_url, test_db_name)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def project_db_session(
    test_db_url: str,
) -> async_sessionmaker[AsyncSession]:
    """Create a session factory pointing to the test DB for direct queries."""
    engine = create_async_engine(test_db_url)
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class TestHealthCheck:
    """Health check still works with webhook components."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200


class TestWebhookUrlValidationViaSettings:
    """HTTPS validation on magic_link_webhook via auth settings endpoint."""

    def test_rejects_http_webhook_url(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.post(
            f"/v1/projects/{project['id']}/auth/settings",
            json={"magic_link_webhook": "http://example.com/hook"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 400
        assert "HTTPS" in resp.json()["detail"]

    def test_accepts_https_webhook_url(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        resp = client.post(
            f"/v1/projects/{project['id']}/auth/settings",
            json={"magic_link_webhook": "https://example.com/hook"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["magic_link_webhook"] == "https://example.com/hook"

    def test_webhook_url_persists(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        # Set webhook
        client.post(
            f"/v1/projects/{project_id}/auth/settings",
            json={"magic_link_webhook": "https://hooks.example.com/auth"},
            headers=auth_headers(token),
        )

        # Read back
        resp = client.get(
            f"/v1/projects/{project_id}/auth/settings",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["magic_link_webhook"] == "https://hooks.example.com/auth"


class TestVerificationTokenStorage:
    """Token storage and retrieval in _pqdb_verification_tokens table."""

    @pytest.mark.asyncio()
    async def test_store_and_retrieve_token(
        self, project_db_session: async_sessionmaker[AsyncSession]
    ) -> None:
        """Store a verification token and retrieve it."""
        async with project_db_session() as session:
            await ensure_auth_tables(session)

            token = generate_verification_token()
            token_hash = hash_verification_token(token)
            token_id = str(uuid.uuid4())
            email = "user@example.com"

            await session.execute(
                text(
                    "INSERT INTO _pqdb_verification_tokens "
                    "(id, email, token_hash, type, expires_at) "
                    "VALUES (:id, :email, :hash, :type, now() + interval '1 hour')"
                ),
                {
                    "id": token_id,
                    "email": email,
                    "hash": token_hash,
                    "type": "magic_link",
                },
            )
            await session.commit()

            # Retrieve
            result = await session.execute(
                text(
                    "SELECT token_hash, email, type, used "
                    "FROM _pqdb_verification_tokens WHERE id = :id"
                ),
                {"id": token_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[1] == email
            assert row[2] == "magic_link"
            assert row[3] is False
            # Verify token hash round-trip
            assert verify_verification_token(row[0], token) is True

    @pytest.mark.asyncio()
    async def test_token_with_user_id(
        self, project_db_session: async_sessionmaker[AsyncSession]
    ) -> None:
        """Store a token linked to a user."""
        async with project_db_session() as session:
            await ensure_auth_tables(session)

            # Create a user first
            user_id = str(uuid.uuid4())
            await session.execute(
                text(
                    "INSERT INTO _pqdb_users (id, email, password_hash) "
                    "VALUES (:id, :email, :pw)"
                ),
                {"id": user_id, "email": "user@test.com", "pw": "hash123"},
            )

            token = generate_verification_token()
            token_hash = hash_verification_token(token)
            token_id = str(uuid.uuid4())

            await session.execute(
                text(
                    "INSERT INTO _pqdb_verification_tokens "
                    "(id, user_id, email, token_hash, type) "
                    "VALUES (:id, :uid, :email, :hash, :type)"
                ),
                {
                    "id": token_id,
                    "uid": user_id,
                    "email": "user@test.com",
                    "hash": token_hash,
                    "type": "email_verification",
                },
            )
            await session.commit()

            result = await session.execute(
                text(
                    "SELECT user_id, type FROM _pqdb_verification_tokens WHERE id = :id"
                ),
                {"id": token_id},
            )
            row = result.fetchone()
            assert row is not None
            assert str(row[0]) == user_id
            assert row[1] == "email_verification"

    @pytest.mark.asyncio()
    async def test_mark_token_as_used(
        self, project_db_session: async_sessionmaker[AsyncSession]
    ) -> None:
        """Mark a verification token as used."""
        async with project_db_session() as session:
            await ensure_auth_tables(session)

            token = generate_verification_token()
            token_hash = hash_verification_token(token)
            token_id = str(uuid.uuid4())

            await session.execute(
                text(
                    "INSERT INTO _pqdb_verification_tokens "
                    "(id, email, token_hash, type) "
                    "VALUES (:id, :email, :hash, :type)"
                ),
                {
                    "id": token_id,
                    "email": "user@test.com",
                    "hash": token_hash,
                    "type": "password_reset",
                },
            )
            await session.commit()

            # Mark as used
            await session.execute(
                text(
                    "UPDATE _pqdb_verification_tokens SET used = TRUE WHERE id = :id"
                ),
                {"id": token_id},
            )
            await session.commit()

            result = await session.execute(
                text("SELECT used FROM _pqdb_verification_tokens WHERE id = :id"),
                {"id": token_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] is True

    @pytest.mark.asyncio()
    async def test_user_id_nullable(
        self, project_db_session: async_sessionmaker[AsyncSession]
    ) -> None:
        """user_id is nullable in _pqdb_verification_tokens."""
        async with project_db_session() as session:
            await ensure_auth_tables(session)

            token = generate_verification_token()
            token_hash = hash_verification_token(token)
            token_id = str(uuid.uuid4())

            # Insert without user_id
            await session.execute(
                text(
                    "INSERT INTO _pqdb_verification_tokens "
                    "(id, email, token_hash, type) "
                    "VALUES (:id, :email, :hash, :type)"
                ),
                {
                    "id": token_id,
                    "email": "new@test.com",
                    "hash": token_hash,
                    "type": "magic_link",
                },
            )
            await session.commit()

            result = await session.execute(
                text(
                    "SELECT user_id FROM _pqdb_verification_tokens WHERE id = :id"
                ),
                {"id": token_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] is None


class TestWebhookDispatchIntegration:
    """Integration test for webhook dispatch with mock HTTP server."""

    @pytest.mark.asyncio()
    async def test_dispatch_to_mock_server(self) -> None:
        """Test webhook dispatch against a real HTTP server."""
        import asyncio
        from http.server import BaseHTTPRequestHandler, HTTPServer
        import json
        import ssl

        received_payloads: list[dict[str, Any]] = []

        class WebhookHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length)
                payload = json.loads(body)
                received_payloads.append(payload)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK")

            def log_message(self, format: str, *args: Any) -> None:
                pass  # Suppress logs

        # Use plain HTTP with a mock — can't easily do HTTPS in tests
        # but we test the dispatch logic, not TLS
        server = HTTPServer(("127.0.0.1", 0), WebhookHandler)
        port = server.server_address[1]
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            dispatcher = WebhookDispatcher(timeout=5.0)
            # Use http for the test server (validation is separate from dispatch)
            await dispatcher.dispatch(
                url=f"http://127.0.0.1:{port}/webhook",
                event_type="magic_link",
                email="user@test.com",
                token="test-token-abc",
                expires_in=3600,
            )

            assert len(received_payloads) == 1
            payload = received_payloads[0]
            assert payload["type"] == "magic_link"
            assert payload["to"] == "user@test.com"
            assert payload["token"] == "test-token-abc"
            assert payload["expires_in"] == 3600
        finally:
            server.shutdown()

    @pytest.mark.asyncio()
    async def test_dispatch_fire_and_forget_on_connection_error(self) -> None:
        """Dispatch should not raise when the webhook URL is unreachable."""
        dispatcher = WebhookDispatcher(timeout=1.0)
        # This URL will fail to connect
        await dispatcher.dispatch(
            url="https://192.0.2.1:9999/webhook",  # TEST-NET, unreachable
            event_type="email_verification",
            email="user@test.com",
            token="test-token",
            expires_in=1800,
        )
        # If we get here without exception, the test passes
