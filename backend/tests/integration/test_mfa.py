"""Integration tests for MFA/TOTP endpoints (US-039).

Boots the real FastAPI app with real Postgres, tests the full flow:
enroll → verify → login requires MFA → challenge with TOTP → authenticated
recovery code works as substitute for TOTP
unenroll requires valid TOTP code
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pyotp
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
from pqdb_api.routes.mfa import router as mfa_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _make_mfa_app(test_db_url: str, test_db_name: str) -> FastAPI:
    """Build a test FastAPI app for MFA integration tests."""
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
    app.include_router(mfa_router)
    return app


@pytest.fixture()
def client(test_db_url: str, test_db_name: str) -> Iterator[TestClient]:
    app = _make_mfa_app(test_db_url, test_db_name)
    with TestClient(app) as c:
        yield c


_TEST_PASSWORD = "securepass123"  # nosemgrep: hardcoded-password-default-argument


def _signup_user(client: TestClient, email: str = "mfa@example.com") -> dict:  # type: ignore[type-arg]
    """Sign up a user and return the response JSON."""
    resp = client.post(
        "/v1/auth/users/signup",
        json={"email": email, "password": _TEST_PASSWORD},
    )
    assert resp.status_code == 201
    return resp.json()  # type: ignore[no-any-return]


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class TestMFARoutesExist:
    """Verify all MFA routes are registered and don't 404."""

    def test_enroll_route_exists(self, client: TestClient) -> None:
        resp = client.post("/v1/auth/users/mfa/enroll")
        assert resp.status_code != 404

    def test_verify_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": "000000"},
        )
        assert resp.status_code != 404

    def test_challenge_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": "fake", "code": "000000"},
        )
        assert resp.status_code != 404

    def test_unenroll_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/mfa/unenroll",
            json={"code": "000000"},
        )
        assert resp.status_code != 404


class TestMFAEnroll:
    """Tests for POST /v1/auth/users/mfa/enroll."""

    def test_enroll_success(self, client: TestClient) -> None:
        data = _signup_user(client)
        token = data["access_token"]

        resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "secret" in body
        assert "qr_uri" in body
        assert "recovery_codes" in body
        assert len(body["recovery_codes"]) == 10
        assert all(len(c) == 8 for c in body["recovery_codes"])
        assert body["qr_uri"].startswith("otpauth://totp/")

    def test_enroll_duplicate_returns_409(self, client: TestClient) -> None:
        data = _signup_user(client, email="dup-mfa@example.com")
        token = data["access_token"]

        # First enroll succeeds
        resp1 = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        assert resp1.status_code == 200

        # Second enroll returns 409
        resp2 = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        assert resp2.status_code == 409

    def test_enroll_requires_auth(self, client: TestClient) -> None:
        resp = client.post("/v1/auth/users/mfa/enroll")
        assert resp.status_code == 401


class TestMFAVerify:
    """Tests for POST /v1/auth/users/mfa/verify."""

    def test_verify_success(self, client: TestClient) -> None:
        data = _signup_user(client, email="verify-mfa@example.com")
        token = data["access_token"]

        # Enroll
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        secret = enroll_resp.json()["secret"]

        # Generate valid TOTP code
        totp = pyotp.TOTP(secret)
        code = totp.now()

        # Verify
        resp = client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": code},
            headers=_auth_header(token),
        )
        assert resp.status_code == 200

    def test_verify_invalid_code(self, client: TestClient) -> None:
        data = _signup_user(client, email="badcode-mfa@example.com")
        token = data["access_token"]

        client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )

        resp = client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": "000000"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 400

    def test_verify_no_factor(self, client: TestClient) -> None:
        data = _signup_user(client, email="nofactor-mfa@example.com")
        token = data["access_token"]

        resp = client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": "123456"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 404


class TestMFALoginFlow:
    """Test that login returns mfa_required when MFA is active."""

    def _setup_mfa_user(
        self, client: TestClient, email: str = "mfalogin@example.com"
    ) -> tuple[str, str]:
        """Create a user with verified MFA. Returns (email, totp_secret)."""
        data = _signup_user(client, email=email)
        token = data["access_token"]

        # Enroll
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        secret = enroll_resp.json()["secret"]

        # Verify
        totp = pyotp.TOTP(secret)
        client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": totp.now()},
            headers=_auth_header(token),
        )

        return email, secret

    def test_login_returns_mfa_required(self, client: TestClient) -> None:
        email, _secret = self._setup_mfa_user(client)

        resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": _TEST_PASSWORD},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["mfa_required"] is True
        assert "mfa_ticket" in data
        assert "access_token" not in data

    def test_mfa_challenge_with_totp(self, client: TestClient) -> None:
        email, secret = self._setup_mfa_user(client, email="challenge-totp@example.com")

        # Login — get MFA ticket
        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": _TEST_PASSWORD},
        )
        ticket = login_resp.json()["mfa_ticket"]

        # Challenge with TOTP code
        totp = pyotp.TOTP(secret)
        resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": ticket, "code": totp.now()},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["user"]["email"] == email

    def test_mfa_challenge_with_invalid_totp(self, client: TestClient) -> None:
        email, _secret = self._setup_mfa_user(client, email="bad-totp@example.com")

        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": _TEST_PASSWORD},
        )
        ticket = login_resp.json()["mfa_ticket"]

        resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": ticket, "code": "000000"},
        )
        assert resp.status_code == 401

    def test_mfa_challenge_with_invalid_ticket(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": "invalid.jwt.token", "code": "123456"},
        )
        assert resp.status_code == 401


class TestRecoveryCodeFlow:
    """Test recovery codes as TOTP substitutes."""

    def test_recovery_code_works_in_challenge(self, client: TestClient) -> None:
        password = _TEST_PASSWORD
        email = "recovery@example.com"
        data = _signup_user(client, email=email)
        token = data["access_token"]

        # Enroll + get recovery codes
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        enroll_data = enroll_resp.json()
        secret = enroll_data["secret"]
        recovery_codes = enroll_data["recovery_codes"]

        # Verify MFA
        totp = pyotp.TOTP(secret)
        client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": totp.now()},
            headers=_auth_header(token),
        )

        # Login — get MFA ticket
        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": password},
        )
        ticket = login_resp.json()["mfa_ticket"]

        # Challenge with recovery code
        resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": ticket, "recovery_code": recovery_codes[0]},
        )
        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_used_recovery_code_rejected(self, client: TestClient) -> None:
        password = _TEST_PASSWORD
        email = "recovery-used@example.com"
        data = _signup_user(client, email=email)
        token = data["access_token"]

        # Enroll + get recovery codes
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        enroll_data = enroll_resp.json()
        secret = enroll_data["secret"]
        recovery_codes = enroll_data["recovery_codes"]

        # Verify MFA
        totp = pyotp.TOTP(secret)
        client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": totp.now()},
            headers=_auth_header(token),
        )

        # First use of recovery code
        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": password},
        )
        ticket = login_resp.json()["mfa_ticket"]
        resp1 = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": ticket, "recovery_code": recovery_codes[0]},
        )
        assert resp1.status_code == 200

        # Second use of same recovery code — should fail
        login_resp2 = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": password},
        )
        ticket2 = login_resp2.json()["mfa_ticket"]
        resp2 = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": ticket2, "recovery_code": recovery_codes[0]},
        )
        assert resp2.status_code == 401

    def test_invalid_recovery_code_rejected(self, client: TestClient) -> None:
        password = _TEST_PASSWORD
        email = "recovery-bad@example.com"
        data = _signup_user(client, email=email)
        token = data["access_token"]

        # Enroll + verify
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        secret = enroll_resp.json()["secret"]
        totp = pyotp.TOTP(secret)
        client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": totp.now()},
            headers=_auth_header(token),
        )

        # Login → challenge with bad recovery code
        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": password},
        )
        ticket = login_resp.json()["mfa_ticket"]
        resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": ticket, "recovery_code": "badcode1"},
        )
        assert resp.status_code == 401


class TestMFAUnenroll:
    """Tests for POST /v1/auth/users/mfa/unenroll."""

    def test_unenroll_success(self, client: TestClient) -> None:
        data = _signup_user(client, email="unenroll@example.com")
        token = data["access_token"]

        # Enroll + verify
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        secret = enroll_resp.json()["secret"]
        totp = pyotp.TOTP(secret)
        client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": totp.now()},
            headers=_auth_header(token),
        )

        # Unenroll with valid TOTP code
        resp = client.post(
            "/v1/auth/users/mfa/unenroll",
            json={"code": totp.now()},
            headers=_auth_header(token),
        )
        assert resp.status_code == 200

        # Login should now return tokens directly (no MFA)
        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": "unenroll@example.com", "password": _TEST_PASSWORD},
        )
        assert login_resp.status_code == 200
        assert "access_token" in login_resp.json()
        assert "mfa_required" not in login_resp.json()

    def test_unenroll_invalid_code(self, client: TestClient) -> None:
        data = _signup_user(client, email="unenroll-bad@example.com")
        token = data["access_token"]

        # Enroll + verify
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(token),
        )
        secret = enroll_resp.json()["secret"]
        totp = pyotp.TOTP(secret)
        client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": totp.now()},
            headers=_auth_header(token),
        )

        # Unenroll with invalid code
        resp = client.post(
            "/v1/auth/users/mfa/unenroll",
            json={"code": "000000"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 400

    def test_unenroll_no_factor(self, client: TestClient) -> None:
        data = _signup_user(client, email="unenroll-none@example.com")
        token = data["access_token"]

        resp = client.post(
            "/v1/auth/users/mfa/unenroll",
            json={"code": "123456"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 404


class TestFullMFAFlow:
    """End-to-end flow: signup → enroll → verify → login (MFA required) →
    challenge with TOTP → authenticated → can access /me."""

    def test_full_flow(self, client: TestClient) -> None:
        email = "fullmfa@example.com"
        password = _TEST_PASSWORD

        # 1. Signup
        signup_resp = client.post(
            "/v1/auth/users/signup",
            json={"email": email, "password": password},
        )
        assert signup_resp.status_code == 201
        access_token = signup_resp.json()["access_token"]

        # 2. Enroll MFA
        enroll_resp = client.post(
            "/v1/auth/users/mfa/enroll",
            headers=_auth_header(access_token),
        )
        assert enroll_resp.status_code == 200
        secret = enroll_resp.json()["secret"]
        recovery_codes = enroll_resp.json()["recovery_codes"]
        assert len(recovery_codes) == 10

        # 3. Verify MFA
        totp = pyotp.TOTP(secret)
        verify_resp = client.post(
            "/v1/auth/users/mfa/verify",
            json={"code": totp.now()},
            headers=_auth_header(access_token),
        )
        assert verify_resp.status_code == 200

        # 4. Login — should require MFA
        login_resp = client.post(
            "/v1/auth/users/login",
            json={"email": email, "password": password},
        )
        assert login_resp.status_code == 200
        login_data = login_resp.json()
        assert login_data["mfa_required"] is True
        assert "mfa_ticket" in login_data

        # 5. Challenge with TOTP
        challenge_resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": login_data["mfa_ticket"], "code": totp.now()},
        )
        assert challenge_resp.status_code == 200
        challenge_data = challenge_resp.json()
        assert "access_token" in challenge_data
        assert "refresh_token" in challenge_data

        # 6. Access /me with new token
        me_resp = client.get(
            "/v1/auth/users/me",
            headers=_auth_header(challenge_data["access_token"]),
        )
        assert me_resp.status_code == 200
        assert me_resp.json()["email"] == email


class TestHealthCheck:
    """Health check still works with MFA routes."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
