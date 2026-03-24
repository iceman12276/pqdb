"""Integration tests for the realtime WebSocket endpoint.

Tests the /v1/realtime WebSocket with a real FastAPI app, verifying
auth handshake, subscribe/unsubscribe protocol, heartbeat, and error
handling. Uses the Starlette TestClient WebSocket support.
"""

from __future__ import annotations

import socket
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from starlette.testclient import TestClient

from pqdb_api.database import get_session
from pqdb_api.routes.health import router as health_router
from pqdb_api.services.auth import generate_mldsa65_keypair
from pqdb_api.services.rate_limiter import RateLimiter

# ---------------------------------------------------------------------------
# Skip if Postgres is unavailable
# ---------------------------------------------------------------------------
PG_HOST = "localhost"
PG_PORT = 5432


def _pg_available() -> bool:
    try:
        with socket.create_connection((PG_HOST, PG_PORT), timeout=2):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_available(),
    reason="Integration tests require Postgres on localhost:5432",
)


# ---------------------------------------------------------------------------
# Test app factory — mocks auth to avoid needing real API keys
# ---------------------------------------------------------------------------
_TEST_PROJECT_ID = uuid.uuid4()
_TEST_DB_NAME = "test_db"
_TEST_APIKEY = "pqdb_anon_testkey1234567890abcdef"


def _make_ws_test_app(test_db_url: str) -> FastAPI:
    """Build a test app with the WebSocket endpoint and mocked auth."""
    from pqdb_api.config import Settings

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

        private_key, public_key = generate_mldsa65_keypair()
        app.state.mldsa65_private_key = private_key
        app.state.mldsa65_public_key = public_key
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings

    # Add health router for basic validation
    app.include_router(health_router)

    # Add the WebSocket route with a wrapper that bypasses real auth
    async def _test_ws_endpoint(websocket: Any) -> None:
        """WebSocket endpoint with mocked auth for testing."""
        from starlette.websockets import WebSocket as WSType

        ws: WSType = websocket

        apikey = ws.query_params.get("apikey")
        if not apikey:
            await ws.close(code=4001, reason="Missing apikey parameter")
            return

        if apikey != _TEST_APIKEY:
            await ws.close(code=4001, reason="Invalid API key")
            return

        await ws.accept()

        from pqdb_api.services.realtime_ws import (
            ConnectionState,
            RealtimeProtocol,
            parse_ws_message,
        )

        state = ConnectionState(
            project_id=str(_TEST_PROJECT_ID),
            key_role="anon",
        )

        while True:
            try:
                raw = await ws.receive_text()
            except Exception:
                break

            msg = parse_ws_message(raw)

            if msg["type"] == "error":
                await ws.send_json(RealtimeProtocol.error(msg["message"]))
                continue

            if msg["type"] == "heartbeat":
                await ws.send_json(RealtimeProtocol.heartbeat())
                continue

            if msg["type"] == "subscribe":
                table = msg["table"]
                ok = state.subscriptions.subscribe(table)
                if ok:
                    await ws.send_json(RealtimeProtocol.ack("subscribe", table))
                else:
                    if state.subscriptions.is_subscribed(table):
                        await ws.send_json(
                            RealtimeProtocol.error(f"Already subscribed to '{table}'")
                        )
                    else:
                        await ws.send_json(
                            RealtimeProtocol.error(
                                "Maximum table subscriptions reached (50)"
                            )
                        )
                continue

            if msg["type"] == "unsubscribe":
                table = msg["table"]
                ok = state.subscriptions.unsubscribe(table)
                if ok:
                    await ws.send_json(RealtimeProtocol.ack("unsubscribe", table))
                else:
                    await ws.send_json(
                        RealtimeProtocol.error(f"Not subscribed to '{table}'")
                    )
                continue

    app.add_websocket_route("/v1/realtime", _test_ws_endpoint)
    return app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def test_db_url(test_db_name: str) -> str:
    return f"postgresql+asyncpg://postgres:postgres@{PG_HOST}:{PG_PORT}/{test_db_name}"


@pytest.fixture()
def ws_client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_ws_test_app(test_db_url)
    with TestClient(app) as client:
        yield client


# ---------------------------------------------------------------------------
# Auth tests
# ---------------------------------------------------------------------------
class TestWSAuth:
    def test_missing_apikey_closes_connection(self, ws_client: TestClient) -> None:
        with pytest.raises(Exception):
            with ws_client.websocket_connect("/v1/realtime"):
                pass

    def test_invalid_apikey_closes_connection(self, ws_client: TestClient) -> None:
        with pytest.raises(Exception):
            with ws_client.websocket_connect("/v1/realtime?apikey=pqdb_anon_invalid"):
                pass

    def test_valid_apikey_connects(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            # Connection succeeded — send heartbeat to verify
            ws.send_json({"type": "heartbeat"})
            resp = ws.receive_json()
            assert resp["type"] == "heartbeat"


# ---------------------------------------------------------------------------
# Protocol tests
# ---------------------------------------------------------------------------
class TestWSProtocol:
    def test_subscribe_returns_ack(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_json({"type": "subscribe", "table": "users"})
            resp = ws.receive_json()
            assert resp["type"] == "ack"
            assert resp["action"] == "subscribe"
            assert resp["table"] == "users"

    def test_unsubscribe_returns_ack(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_json({"type": "subscribe", "table": "orders"})
            ws.receive_json()  # ack for subscribe
            ws.send_json({"type": "unsubscribe", "table": "orders"})
            resp = ws.receive_json()
            assert resp["type"] == "ack"
            assert resp["action"] == "unsubscribe"
            assert resp["table"] == "orders"

    def test_unsubscribe_not_subscribed_returns_error(
        self, ws_client: TestClient
    ) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_json({"type": "unsubscribe", "table": "nonexistent"})
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Not subscribed" in resp["message"]

    def test_duplicate_subscribe_returns_error(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_json({"type": "subscribe", "table": "users"})
            ws.receive_json()  # first ack
            ws.send_json({"type": "subscribe", "table": "users"})
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Already subscribed" in resp["message"]

    def test_heartbeat_returns_heartbeat(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_json({"type": "heartbeat"})
            resp = ws.receive_json()
            assert resp["type"] == "heartbeat"
            assert "timestamp" in resp

    def test_invalid_json_returns_error(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_text("not json{")
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Invalid JSON" in resp["message"]

    def test_missing_type_returns_error(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_json({"table": "users"})
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Missing 'type'" in resp["message"]

    def test_unknown_type_returns_error(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            ws.send_json({"type": "explode"})
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Unknown message type" in resp["message"]

    def test_subscribe_multiple_tables(self, ws_client: TestClient) -> None:
        with ws_client.websocket_connect(f"/v1/realtime?apikey={_TEST_APIKEY}") as ws:
            for table in ["users", "orders", "products"]:
                ws.send_json({"type": "subscribe", "table": table})
                resp = ws.receive_json()
                assert resp["type"] == "ack"
                assert resp["table"] == table


# ---------------------------------------------------------------------------
# Route registration test (via the real create_app)
# ---------------------------------------------------------------------------
class TestWSRouteRegistered:
    def test_realtime_route_exists_in_app(self) -> None:
        """Verify the /v1/realtime WebSocket route is registered in the app."""
        from pqdb_api.app import create_app
        from pqdb_api.config import Settings

        settings = Settings()
        app = create_app(settings)
        ws_routes = [
            r.path for r in app.routes if hasattr(r, "path") and "realtime" in r.path
        ]
        assert "/v1/realtime" in ws_routes
