"""Integration tests for GET/PUT /v1/auth/me/public-key.

Boots the real FastAPI app with real Postgres, tests key retrieval
and key rotation endpoints.
"""

import base64
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.database import get_session
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.services.auth import generate_mldsa65_keypair

# Skip the entire module if liboqs is not available
try:
    import oqs  # noqa: F401

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    HAS_OQS = False

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)

# ML-KEM-768 public key is exactly 1184 bytes
VALID_PUBLIC_KEY = base64.b64encode(bytes(1184)).decode()
VALID_PUBLIC_KEY_2 = base64.b64encode(bytes([1] * 1184)).decode()
WRONG_LENGTH_KEY = base64.b64encode(bytes(100)).decode()


def _create_test_app(test_db_url: str) -> FastAPI:
    """Create a test FastAPI app with real Postgres."""
    private_key, public_key = generate_mldsa65_keypair()

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
        app.state.mldsa65_private_key = private_key
        app.state.mldsa65_public_key = public_key
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(auth_router)
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _create_test_app(test_db_url)
    with TestClient(app) as c:
        yield c


def _signup(client: TestClient, email: str = "dev@test.com") -> str:
    """Sign up and return the access token."""
    resp = client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "testpass123"},
    )
    assert resp.status_code == 201
    token: str = resp.json()["access_token"]
    return token


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class TestPutPublicKey:
    """Tests for PUT /v1/auth/me/public-key."""

    def test_put_public_key_requires_auth(self, client: TestClient) -> None:
        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": VALID_PUBLIC_KEY},
        )
        assert resp.status_code in (401, 403)

    def test_put_public_key_success(self, client: TestClient) -> None:
        token = _signup(client)

        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": VALID_PUBLIC_KEY},
            headers=_auth(token),
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

        # Verify the key was persisted
        get_resp = client.get(
            "/v1/auth/me/public-key",
            headers=_auth(token),
        )
        assert get_resp.status_code == 200
        assert get_resp.json()["public_key"] == VALID_PUBLIC_KEY

    def test_put_public_key_replaces_existing(self, client: TestClient) -> None:
        """PUT overwrites a previously stored key (key rotation)."""
        token = _signup(client, email="rotate@test.com")

        # Set initial key
        resp1 = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": VALID_PUBLIC_KEY},
            headers=_auth(token),
        )
        assert resp1.status_code == 200

        # Rotate to new key
        resp2 = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": VALID_PUBLIC_KEY_2},
            headers=_auth(token),
        )
        assert resp2.status_code == 200

        # Verify the new key is stored
        get_resp = client.get(
            "/v1/auth/me/public-key",
            headers=_auth(token),
        )
        assert get_resp.status_code == 200
        assert get_resp.json()["public_key"] == VALID_PUBLIC_KEY_2

    def test_put_public_key_rejects_wrong_length(self, client: TestClient) -> None:
        token = _signup(client, email="badlen@test.com")

        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": WRONG_LENGTH_KEY},
            headers=_auth(token),
        )
        assert resp.status_code == 422

    def test_put_public_key_rejects_invalid_base64(self, client: TestClient) -> None:
        token = _signup(client, email="badb64@test.com")

        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": "not-valid-base64!!!"},
            headers=_auth(token),
        )
        assert resp.status_code == 422

    def test_put_public_key_rejects_missing_body(self, client: TestClient) -> None:
        token = _signup(client, email="nobody@test.com")

        resp = client.put(
            "/v1/auth/me/public-key",
            json={},
            headers=_auth(token),
        )
        assert resp.status_code == 422
