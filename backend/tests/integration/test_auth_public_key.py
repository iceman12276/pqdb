"""Integration tests for developer ML-KEM-768 public key handling.

Boots the real FastAPI app with a real Postgres database. Verifies:

1. POST /v1/auth/signup accepts an optional ``ml_kem_public_key`` field
   (base64-encoded). When provided, the decoded bytes are stored on the
   developer record.
2. When the field is omitted the column stays NULL.
3. Malformed base64 in the signup payload is rejected with HTTP 422
   (no silent NULL write).
4. GET /v1/auth/me/public-key returns ``{public_key: str | None}`` for
   the authenticated developer, base64-encoding the stored bytes.
5. GET /v1/auth/me/public-key without a bearer token returns 401.
"""

from __future__ import annotations

import base64
import os
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.services.auth import generate_mldsa65_keypair

# Skip if liboqs is not available (matches test_auth.py pattern)
try:
    import oqs  # noqa: F401

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    HAS_OQS = False

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)


# ML-KEM-768 public keys are 1184 bytes. We generate a deterministic
# fake of the correct length so the server doesn't need to validate
# cryptographic structure at this layer — that is the SDK's job.
ML_KEM_768_PK_LEN = 1184


def _fake_ml_kem_pk() -> bytes:
    return os.urandom(ML_KEM_768_PK_LEN)


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


def _unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"


class TestSignupWithPublicKey:
    """Tests for the ml_kem_public_key field on POST /v1/auth/signup."""

    def test_signup_with_public_key_stores_bytes(self, client: TestClient) -> None:
        """Signup WITH public key -> stored, GET endpoint returns it (bytes match)."""
        pk_bytes = _fake_ml_kem_pk()
        pk_b64 = base64.b64encode(pk_bytes).decode("ascii")
        email = _unique_email("withkey")

        resp = client.post(
            "/v1/auth/signup",
            json={
                "email": email,
                "password": "securepass123",
                "ml_kem_public_key": pk_b64,
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        # Response shape MUST be unchanged: only the token triple.
        assert set(data.keys()) == {"access_token", "refresh_token", "token_type"}
        assert data["token_type"] == "bearer"

        token = data["access_token"]
        get_resp = client.get(
            "/v1/auth/me/public-key",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert get_resp.status_code == 200
        body = get_resp.json()
        assert set(body.keys()) == {"public_key"}
        assert body["public_key"] is not None
        # Bytes must round-trip exactly.
        assert base64.b64decode(body["public_key"]) == pk_bytes

    def test_signup_without_public_key_stores_null(self, client: TestClient) -> None:
        """Signup WITHOUT public key -> stored NULL, GET returns {public_key: null}."""
        email = _unique_email("nokey")

        resp = client.post(
            "/v1/auth/signup",
            json={"email": email, "password": "securepass123"},
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert set(data.keys()) == {"access_token", "refresh_token", "token_type"}

        token = data["access_token"]
        get_resp = client.get(
            "/v1/auth/me/public-key",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert get_resp.status_code == 200
        body = get_resp.json()
        assert body == {"public_key": None}

    def test_signup_with_malformed_base64_returns_422(self, client: TestClient) -> None:
        """Malformed base64 in signup payload must be rejected with 422.

        The server must NOT silently store NULL when the client sent
        something. Bad input is a client error, not a missing value.
        """
        email = _unique_email("badb64")

        resp = client.post(
            "/v1/auth/signup",
            json={
                "email": email,
                "password": "securepass123",
                # Not valid base64 — contains characters outside the alphabet.
                "ml_kem_public_key": "not!!valid##base64@@",
            },
        )
        assert resp.status_code == 422, resp.text


class TestGetPublicKey:
    """Tests for GET /v1/auth/me/public-key."""

    def test_get_public_key_without_token_returns_401(self, client: TestClient) -> None:
        resp = client.get("/v1/auth/me/public-key")
        assert resp.status_code in (401, 403)

    def test_get_public_key_with_invalid_token_returns_401(
        self, client: TestClient
    ) -> None:
        resp = client.get(
            "/v1/auth/me/public-key",
            headers={"Authorization": "Bearer not.a.real.token"},
        )
        assert resp.status_code == 401
