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
    import oqs

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    HAS_OQS = False

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)


# ML-KEM-768 public keys are 1184 bytes (NIST FIPS 203). The server now
# enforces this length at the API boundary, so tests must use real keys
# of the correct length.
ML_KEM_768_PK_LEN = 1184


def _real_ml_kem_pk() -> bytes:
    """Generate a real ML-KEM-768 public key via liboqs."""
    with oqs.KeyEncapsulation("ML-KEM-768") as kem:
        pk: bytes = kem.generate_keypair()
        return pk


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
        pk_bytes = _real_ml_kem_pk()
        assert len(pk_bytes) == ML_KEM_768_PK_LEN
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

    def test_signup_with_wrong_length_key_returns_422(self, client: TestClient) -> None:
        """Bad-length base64 must be rejected at the boundary, not silently stored.

        100 bytes is valid base64 but not a valid ML-KEM-768 public key.
        The invariant is "if developers.ml_kem_public_key is non-NULL,
        it holds exactly 1184 bytes" — the API must enforce it.
        """
        short_b64 = base64.b64encode(b"x" * 100).decode("ascii")
        resp = client.post(
            "/v1/auth/signup",
            json={
                "email": _unique_email("shortkey"),
                "password": "testpassword123",
                "ml_kem_public_key": short_b64,
            },
        )
        assert resp.status_code == 422, resp.text
        # Error message must name the required length so clients know what to fix.
        assert "1184" in resp.text

    def test_signup_with_empty_string_key_returns_422(self, client: TestClient) -> None:
        """Empty base64 string must be rejected — empty bytes is not a valid key.

        This is the most important edge case: an empty string decodes
        cleanly to b"" and the old validator would happily persist it.
        """
        resp = client.post(
            "/v1/auth/signup",
            json={
                "email": _unique_email("emptykey"),
                "password": "testpassword123",
                "ml_kem_public_key": "",
            },
        )
        assert resp.status_code == 422, resp.text

    def test_signup_with_oversized_key_returns_422(self, client: TestClient) -> None:
        """Oversized base64 must be rejected at the boundary."""
        long_b64 = base64.b64encode(b"x" * 2000).decode("ascii")
        resp = client.post(
            "/v1/auth/signup",
            json={
                "email": _unique_email("longkey"),
                "password": "testpassword123",
                "ml_kem_public_key": long_b64,
            },
        )
        assert resp.status_code == 422, resp.text


class TestGetPublicKey:
    """Tests for GET /v1/auth/me/public-key."""

    def test_get_public_key_without_token_returns_401(self, client: TestClient) -> None:
        resp = client.get("/v1/auth/me/public-key")
        # Strict 401 per the AC — missing credentials is an authentication
        # failure, not an authorization failure. The middleware now uses
        # HTTPBearer(auto_error=False) to raise 401 explicitly.
        assert resp.status_code == 401

    def test_get_public_key_with_invalid_token_returns_401(
        self, client: TestClient
    ) -> None:
        resp = client.get(
            "/v1/auth/me/public-key",
            headers={"Authorization": "Bearer not.a.real.token"},
        )
        assert resp.status_code == 401

    def test_two_developers_get_isolated_keys(self, client: TestClient) -> None:
        """Cross-tenant safety: each developer's GET returns ONLY their own key.

        This is the most important test for the read path. A silent
        cross-tenant leak would be catastrophic in a multi-tenant system,
        so verify both developers get their own key and that the keys
        are NOT crossed.
        """
        pk_a = _real_ml_kem_pk()
        pk_b = _real_ml_kem_pk()
        assert pk_a != pk_b  # sanity: keypairs are random

        resp_a = client.post(
            "/v1/auth/signup",
            json={
                "email": _unique_email("isolation_a"),
                "password": "testpassword123",
                "ml_kem_public_key": base64.b64encode(pk_a).decode("ascii"),
            },
        )
        assert resp_a.status_code == 201, resp_a.text
        token_a = resp_a.json()["access_token"]

        resp_b = client.post(
            "/v1/auth/signup",
            json={
                "email": _unique_email("isolation_b"),
                "password": "testpassword123",
                "ml_kem_public_key": base64.b64encode(pk_b).decode("ascii"),
            },
        )
        assert resp_b.status_code == 201, resp_b.text
        token_b = resp_b.json()["access_token"]

        get_a = client.get(
            "/v1/auth/me/public-key",
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert get_a.status_code == 200
        assert base64.b64decode(get_a.json()["public_key"]) == pk_a

        get_b = client.get(
            "/v1/auth/me/public-key",
            headers={"Authorization": f"Bearer {token_b}"},
        )
        assert get_b.status_code == 200
        assert base64.b64decode(get_b.json()["public_key"]) == pk_b

        # Critical: keys are NOT crossed.
        assert base64.b64decode(get_a.json()["public_key"]) != pk_b
        assert base64.b64decode(get_b.json()["public_key"]) != pk_a


class TestPutPublicKey:
    """Tests for PUT /v1/auth/me/public-key (key rotation)."""

    def _signup_and_auth(
        self,
        client: TestClient,
        email: str,
    ) -> tuple[str, dict[str, str]]:
        """Sign up and return (token, auth headers)."""
        resp = client.post(
            "/v1/auth/signup",
            json={"email": email, "password": "securepass123"},
        )
        assert resp.status_code == 201, resp.text
        token: str = resp.json()["access_token"]
        return token, {"Authorization": f"Bearer {token}"}

    def test_put_public_key_requires_auth(self, client: TestClient) -> None:
        pk_b64 = base64.b64encode(_real_ml_kem_pk()).decode("ascii")
        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": pk_b64},
        )
        assert resp.status_code == 401

    def test_put_public_key_success(self, client: TestClient) -> None:
        pk_bytes = _real_ml_kem_pk()
        pk_b64 = base64.b64encode(pk_bytes).decode("ascii")
        _, headers = self._signup_and_auth(client, _unique_email("put"))

        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": pk_b64},
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

        get_resp = client.get("/v1/auth/me/public-key", headers=headers)
        assert get_resp.status_code == 200
        assert base64.b64decode(get_resp.json()["public_key"]) == pk_bytes

    def test_put_public_key_replaces_existing(self, client: TestClient) -> None:
        """PUT overwrites a previously stored key (key rotation)."""
        pk_a = _real_ml_kem_pk()
        pk_b = _real_ml_kem_pk()
        assert pk_a != pk_b
        _, headers = self._signup_and_auth(client, _unique_email("rotate"))

        client.put(
            "/v1/auth/me/public-key",
            json={"public_key": base64.b64encode(pk_a).decode("ascii")},
            headers=headers,
        )
        client.put(
            "/v1/auth/me/public-key",
            json={"public_key": base64.b64encode(pk_b).decode("ascii")},
            headers=headers,
        )

        get_resp = client.get("/v1/auth/me/public-key", headers=headers)
        assert base64.b64decode(get_resp.json()["public_key"]) == pk_b

    def test_put_public_key_rejects_wrong_length(self, client: TestClient) -> None:
        _, headers = self._signup_and_auth(client, _unique_email("putbadlen"))
        short_b64 = base64.b64encode(b"x" * 100).decode("ascii")
        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": short_b64},
            headers=headers,
        )
        assert resp.status_code == 422
        assert "1184" in resp.text

    def test_put_public_key_rejects_invalid_base64(self, client: TestClient) -> None:
        _, headers = self._signup_and_auth(client, _unique_email("putbadb64"))
        resp = client.put(
            "/v1/auth/me/public-key",
            json={"public_key": "not!!valid##base64@@"},
            headers=headers,
        )
        assert resp.status_code == 422

    def test_put_public_key_rejects_missing_body(self, client: TestClient) -> None:
        _, headers = self._signup_and_auth(client, _unique_email("putnobody"))
        resp = client.put(
            "/v1/auth/me/public-key",
            json={},
            headers=headers,
        )
        assert resp.status_code == 422
