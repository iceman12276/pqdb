"""Integration tests for passkey/WebAuthn routes — US-053.

Boots real FastAPI app with real Postgres, tests:
- Challenge generation (registration + authentication)
- Registration flow with mocked attestation
- Authentication flow with mocked assertion
- Passkey listing and deletion
- Error cases
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, patch

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
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.passkeys import _challenge_store
from pqdb_api.routes.passkeys import router as passkeys_router
from pqdb_api.services.auth import (
    JWT_ALGORITHM,
    generate_ed25519_keypair,
)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------
def _make_passkey_app(test_db_url: str) -> FastAPI:
    """Build a test app with passkey routes backed by real Postgres."""
    private_key, public_key = generate_ed25519_keypair()

    settings = Settings(
        database_url=test_db_url,
        webauthn_rp_id="localhost",
        webauthn_rp_name="pqdb",
        webauthn_origin="http://localhost:3000",
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
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(passkeys_router)
    return app


def _signup_and_get_token(
    client: TestClient, app: FastAPI, email: str = "dev@test.com"
) -> tuple[str, str]:
    """Sign up a developer and return (access_token, developer_id)."""
    resp = client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "testpass123"},
    )
    assert resp.status_code == 201
    token = resp.json()["access_token"]
    import jwt as pyjwt

    payload = pyjwt.decode(token, app.state.jwt_public_key, algorithms=[JWT_ALGORITHM])
    return token, payload["sub"]


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def passkey_app(test_db_url: str) -> FastAPI:
    return _make_passkey_app(test_db_url)


# ---------------------------------------------------------------------------
# Route existence tests
# ---------------------------------------------------------------------------
class TestRoutesExist:
    def test_challenge_route_exists(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.get("/v1/auth/passkeys/challenge")
            assert resp.status_code != 404

    def test_register_route_exists(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.post("/v1/auth/passkeys/register", json={})
            assert resp.status_code != 404

    def test_authenticate_route_exists(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.post("/v1/auth/passkeys/authenticate", json={})
            assert resp.status_code != 404

    def test_list_route_exists(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.get("/v1/auth/passkeys")
            assert resp.status_code != 404

    def test_health_check(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app) as client:
            resp = client.get("/health")
            assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Challenge endpoint tests
# ---------------------------------------------------------------------------
class TestChallenge:
    def test_authentication_challenge_returns_options(
        self, passkey_app: FastAPI
    ) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/passkeys/challenge", params={"purpose": "authentication"}
            )
            assert resp.status_code == 200
            data = resp.json()
            assert "challenge" in data
            assert "rpId" in data
            assert data["rpId"] == "localhost"

    def test_authentication_challenge_empty_allow_credentials(
        self, passkey_app: FastAPI
    ) -> None:
        """Discoverable credentials: allowCredentials should be empty."""
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/passkeys/challenge", params={"purpose": "authentication"}
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data.get("allowCredentials") == []

    def test_registration_challenge_requires_developer_id(
        self, passkey_app: FastAPI
    ) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/passkeys/challenge",
                params={"purpose": "registration"},
            )
            assert resp.status_code == 400
            assert "requires authentication" in resp.json()["detail"]

    def test_registration_challenge_with_auth(self, passkey_app: FastAPI) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, dev_id = _signup_and_get_token(client, passkey_app)
            resp = client.get(
                "/v1/auth/passkeys/challenge",
                params={"purpose": "registration", "developer_id": dev_id},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert "challenge" in data
            assert data["rp"]["id"] == "localhost"
            assert data["rp"]["name"] == "pqdb"

    def test_challenge_stores_in_memory(self, passkey_app: FastAPI) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.get(
                "/v1/auth/passkeys/challenge", params={"purpose": "authentication"}
            )
            assert resp.status_code == 200
            assert len(_challenge_store) == 1


# ---------------------------------------------------------------------------
# Register endpoint tests (with mocked webauthn verification)
# ---------------------------------------------------------------------------
class TestRegister:
    def test_register_requires_auth(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.post(
                "/v1/auth/passkeys/register",
                json={"credential": {}, "name": "My Key"},
            )
            assert resp.status_code in (401, 403)

    def test_register_rejects_invalid_challenge(self, passkey_app: FastAPI) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, dev_id = _signup_and_get_token(client, passkey_app)

            # Fake credential with a challenge that's not in the store
            fake_client_data = json.dumps(
                {
                    "challenge": "nonexistent",
                    "origin": "http://localhost:3000",
                    "type": "webauthn.create",
                }
            ).encode()
            resp = client.post(
                "/v1/auth/passkeys/register",
                json={
                    "credential": {
                        "response": {
                            "clientDataJSON": _b64url_encode(fake_client_data),
                        },
                    },
                    "name": "My Key",
                },
                headers=_auth_headers(token),
            )
            assert resp.status_code == 400
            assert "Challenge not found" in resp.json()["detail"]

    def test_register_full_flow_mocked(self, passkey_app: FastAPI) -> None:
        """Register a passkey with mocked webauthn verification."""
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, dev_id = _signup_and_get_token(client, passkey_app)

            # Get a registration challenge
            resp = client.get(
                "/v1/auth/passkeys/challenge",
                params={"purpose": "registration", "developer_id": dev_id},
            )
            assert resp.status_code == 200
            challenge_b64 = resp.json()["challenge"]

            # Build fake credential response with the correct challenge
            fake_client_data = json.dumps(
                {
                    "challenge": challenge_b64,
                    "origin": "http://localhost:3000",
                    "type": "webauthn.create",
                }
            ).encode()

            cred_id = b"\x01\x02\x03\x04"
            pub_key = b"\x05\x06\x07\x08" * 16  # 64 bytes

            # Mock verify_registration_response
            mock_verification = MagicMock()
            mock_verification.credential_id = cred_id
            mock_verification.credential_public_key = pub_key
            mock_verification.sign_count = 0

            with patch(
                "pqdb_api.routes.passkeys.webauthn.verify_registration_response",
                return_value=mock_verification,
            ):
                resp = client.post(
                    "/v1/auth/passkeys/register",
                    json={
                        "credential": {
                            "response": {
                                "clientDataJSON": _b64url_encode(fake_client_data),
                                "attestationObject": _b64url_encode(b"\x00" * 32),
                            },
                            "id": _b64url_encode(cred_id),
                            "rawId": _b64url_encode(cred_id),
                            "type": "public-key",
                        },
                        "name": "Test Passkey",
                    },
                    headers=_auth_headers(token),
                )
                assert resp.status_code == 200
                data = resp.json()
                assert data["name"] == "Test Passkey"
                assert data["id"] == _b64url_encode(cred_id)


# ---------------------------------------------------------------------------
# Authenticate endpoint tests (with mocked webauthn verification)
# ---------------------------------------------------------------------------
class TestAuthenticate:
    def test_authenticate_rejects_unknown_credential(
        self, passkey_app: FastAPI
    ) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            # Get an authentication challenge
            resp = client.get(
                "/v1/auth/passkeys/challenge", params={"purpose": "authentication"}
            )
            assert resp.status_code == 200
            challenge_b64 = resp.json()["challenge"]

            fake_client_data = json.dumps(
                {
                    "challenge": challenge_b64,
                    "origin": "http://localhost:3000",
                    "type": "webauthn.get",
                }
            ).encode()

            resp = client.post(
                "/v1/auth/passkeys/authenticate",
                json={
                    "credential": {
                        "response": {
                            "clientDataJSON": _b64url_encode(fake_client_data),
                            "authenticatorData": _b64url_encode(b"\x00" * 37),
                            "signature": _b64url_encode(b"\x00" * 64),
                        },
                        "id": _b64url_encode(b"\xff\xfe"),
                        "rawId": _b64url_encode(b"\xff\xfe"),
                        "type": "public-key",
                    },
                },
            )
            assert resp.status_code == 400
            assert "not recognized" in resp.json()["detail"]

    def test_full_register_then_authenticate(self, passkey_app: FastAPI) -> None:
        """Register a passkey, then authenticate with it — full lifecycle."""
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, dev_id = _signup_and_get_token(client, passkey_app)

            # -- REGISTER --
            resp = client.get(
                "/v1/auth/passkeys/challenge",
                params={"purpose": "registration", "developer_id": dev_id},
            )
            assert resp.status_code == 200
            reg_challenge_b64 = resp.json()["challenge"]

            reg_client_data = json.dumps(
                {
                    "challenge": reg_challenge_b64,
                    "origin": "http://localhost:3000",
                    "type": "webauthn.create",
                }
            ).encode()

            cred_id = b"\x10\x20\x30\x40"
            pub_key = b"\x50\x60\x70\x80" * 16

            mock_reg = MagicMock()
            mock_reg.credential_id = cred_id
            mock_reg.credential_public_key = pub_key
            mock_reg.sign_count = 0

            with patch(
                "pqdb_api.routes.passkeys.webauthn.verify_registration_response",
                return_value=mock_reg,
            ):
                resp = client.post(
                    "/v1/auth/passkeys/register",
                    json={
                        "credential": {
                            "response": {
                                "clientDataJSON": _b64url_encode(reg_client_data),
                                "attestationObject": _b64url_encode(b"\x00" * 32),
                            },
                            "id": _b64url_encode(cred_id),
                            "rawId": _b64url_encode(cred_id),
                            "type": "public-key",
                        },
                        "name": "Lifecycle Key",
                    },
                    headers=_auth_headers(token),
                )
                assert resp.status_code == 200

            # -- AUTHENTICATE --
            resp = client.get(
                "/v1/auth/passkeys/challenge", params={"purpose": "authentication"}
            )
            assert resp.status_code == 200
            auth_challenge_b64 = resp.json()["challenge"]

            auth_client_data = json.dumps(
                {
                    "challenge": auth_challenge_b64,
                    "origin": "http://localhost:3000",
                    "type": "webauthn.get",
                }
            ).encode()

            mock_auth = MagicMock()
            mock_auth.new_sign_count = 1

            with patch(
                "pqdb_api.routes.passkeys.webauthn.verify_authentication_response",
                return_value=mock_auth,
            ):
                resp = client.post(
                    "/v1/auth/passkeys/authenticate",
                    json={
                        "credential": {
                            "response": {
                                "clientDataJSON": _b64url_encode(auth_client_data),
                                "authenticatorData": _b64url_encode(b"\x00" * 37),
                                "signature": _b64url_encode(b"\x00" * 64),
                            },
                            "id": _b64url_encode(cred_id),
                            "rawId": _b64url_encode(cred_id),
                            "type": "public-key",
                        },
                    },
                )
                assert resp.status_code == 200
                data = resp.json()
                assert "access_token" in data
                assert "refresh_token" in data
                assert data["token_type"] == "bearer"

                # Verify the JWT was issued for the correct developer
                import jwt as pyjwt

                payload = pyjwt.decode(
                    data["access_token"],
                    passkey_app.state.jwt_public_key,
                    algorithms=[JWT_ALGORITHM],
                )
                assert payload["sub"] == dev_id
                assert payload["type"] == "access"


# ---------------------------------------------------------------------------
# List / Delete tests
# ---------------------------------------------------------------------------
class TestListAndDelete:
    def test_list_empty(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, _ = _signup_and_get_token(client, passkey_app)
            resp = client.get("/v1/auth/passkeys", headers=_auth_headers(token))
            assert resp.status_code == 200
            assert resp.json() == []

    def test_list_after_register(self, passkey_app: FastAPI) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, dev_id = _signup_and_get_token(client, passkey_app)

            # Register a passkey
            resp = client.get(
                "/v1/auth/passkeys/challenge",
                params={"purpose": "registration", "developer_id": dev_id},
            )
            challenge_b64 = resp.json()["challenge"]
            client_data = json.dumps(
                {
                    "challenge": challenge_b64,
                    "origin": "http://localhost:3000",
                    "type": "webauthn.create",
                }
            ).encode()

            cred_id = b"\xaa\xbb\xcc"
            mock_reg = MagicMock()
            mock_reg.credential_id = cred_id
            mock_reg.credential_public_key = b"\xdd" * 64
            mock_reg.sign_count = 0

            with patch(
                "pqdb_api.routes.passkeys.webauthn.verify_registration_response",
                return_value=mock_reg,
            ):
                resp = client.post(
                    "/v1/auth/passkeys/register",
                    json={
                        "credential": {
                            "response": {
                                "clientDataJSON": _b64url_encode(client_data),
                                "attestationObject": _b64url_encode(b"\x00" * 32),
                            },
                            "id": _b64url_encode(cred_id),
                            "rawId": _b64url_encode(cred_id),
                            "type": "public-key",
                        },
                        "name": "List Test Key",
                    },
                    headers=_auth_headers(token),
                )
                assert resp.status_code == 200

            # List should return 1
            resp = client.get("/v1/auth/passkeys", headers=_auth_headers(token))
            assert resp.status_code == 200
            keys = resp.json()
            assert len(keys) == 1
            assert keys[0]["name"] == "List Test Key"

    def test_delete_passkey(self, passkey_app: FastAPI) -> None:
        _challenge_store.clear()
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, dev_id = _signup_and_get_token(client, passkey_app)

            # Register
            resp = client.get(
                "/v1/auth/passkeys/challenge",
                params={"purpose": "registration", "developer_id": dev_id},
            )
            challenge_b64 = resp.json()["challenge"]
            client_data = json.dumps(
                {
                    "challenge": challenge_b64,
                    "origin": "http://localhost:3000",
                    "type": "webauthn.create",
                }
            ).encode()

            cred_id = b"\x11\x22\x33"
            mock_reg = MagicMock()
            mock_reg.credential_id = cred_id
            mock_reg.credential_public_key = b"\x44" * 64
            mock_reg.sign_count = 0

            with patch(
                "pqdb_api.routes.passkeys.webauthn.verify_registration_response",
                return_value=mock_reg,
            ):
                resp = client.post(
                    "/v1/auth/passkeys/register",
                    json={
                        "credential": {
                            "response": {
                                "clientDataJSON": _b64url_encode(client_data),
                                "attestationObject": _b64url_encode(b"\x00" * 32),
                            },
                            "id": _b64url_encode(cred_id),
                            "rawId": _b64url_encode(cred_id),
                            "type": "public-key",
                        },
                        "name": "Delete Me",
                    },
                    headers=_auth_headers(token),
                )
                assert resp.status_code == 200

            # Delete
            cred_id_b64 = _b64url_encode(cred_id)
            resp = client.delete(
                f"/v1/auth/passkeys/{cred_id_b64}",
                headers=_auth_headers(token),
            )
            assert resp.status_code == 200
            assert resp.json()["status"] == "deleted"

            # List should be empty
            resp = client.get("/v1/auth/passkeys", headers=_auth_headers(token))
            assert resp.status_code == 200
            assert resp.json() == []

    def test_delete_nonexistent_returns_404(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            token, _ = _signup_and_get_token(client, passkey_app)
            resp = client.delete(
                f"/v1/auth/passkeys/{_b64url_encode(b'nonexistent')}",
                headers=_auth_headers(token),
            )
            assert resp.status_code == 404

    def test_delete_requires_auth(self, passkey_app: FastAPI) -> None:
        with TestClient(passkey_app, raise_server_exceptions=False) as client:
            resp = client.delete(f"/v1/auth/passkeys/{_b64url_encode(b'test')}")
            assert resp.status_code in (401, 403)
