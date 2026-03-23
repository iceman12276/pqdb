"""Integration tests for auth rate limits (US-PRE-1).

Boots the real FastAPI app with real Postgres and verifies that
rate limits trigger after the correct number of requests and
return HTTP 429 with the correct response format.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

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
from pqdb_api.services.auth import generate_mldsa65_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient

_EXPECTED_429_ERROR = {
    "error": {
        "code": "rate_limited",
        "message": "Too many requests. Try again later.",
    }
}


def _make_rate_limit_app(test_db_url: str, test_db_name: str) -> FastAPI:
    """Build a test FastAPI app for rate limit integration tests."""
    private_key, public_key = generate_mldsa65_keypair()

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
    app.include_router(mfa_router)
    return app


@pytest.fixture()
def client(test_db_url: str, test_db_name: str) -> Iterator[TestClient]:
    app = _make_rate_limit_app(test_db_url, test_db_name)
    with TestClient(app) as c:
        yield c


class TestSignupRateLimit:
    """Signup: 10 requests/min per IP."""

    def test_signup_rate_limit_triggers_after_10(self, client: TestClient) -> None:
        for i in range(10):
            resp = client.post(
                "/v1/auth/users/signup",
                json={"email": f"user{i}@test.com", "password": "StrongP@ss123"},
            )
            # May be 201 (success) or 409 (duplicate) — not 429 yet
            assert resp.status_code != 429, f"Rate limited too early on request {i + 1}"

        # 11th request should be rate-limited
        resp = client.post(
            "/v1/auth/users/signup",
            json={"email": "extra@test.com", "password": "StrongP@ss123"},
        )
        assert resp.status_code == 429
        body = resp.json()
        assert body["detail"] == _EXPECTED_429_ERROR


class TestLoginRateLimit:
    """Login: 20 requests/min per IP."""

    def test_login_rate_limit_triggers_after_20(self, client: TestClient) -> None:
        for i in range(20):
            resp = client.post(
                "/v1/auth/users/login",
                json={"email": f"user{i}@test.com", "password": "wrong"},
            )
            assert resp.status_code != 429, f"Rate limited too early on request {i + 1}"

        # 21st request should be rate-limited
        resp = client.post(
            "/v1/auth/users/login",
            json={"email": "extra@test.com", "password": "wrong"},
        )
        assert resp.status_code == 429
        body = resp.json()
        assert body["detail"] == _EXPECTED_429_ERROR


class TestResendVerificationRateLimit:
    """Resend verification: 3 requests/min per email."""

    def test_resend_verification_rate_limit_triggers_after_3(
        self, client: TestClient
    ) -> None:
        email = "verify-limit@test.com"
        for i in range(3):
            resp = client.post(
                "/v1/auth/users/resend-verification",
                json={"email": email},
            )
            # Will return 400 (no webhook) or 200 — not 429
            assert resp.status_code != 429, f"Rate limited too early on request {i + 1}"

        # 4th request should be rate-limited
        resp = client.post(
            "/v1/auth/users/resend-verification",
            json={"email": email},
        )
        assert resp.status_code == 429
        body = resp.json()
        assert body["detail"] == _EXPECTED_429_ERROR

    def test_different_emails_have_separate_limits(self, client: TestClient) -> None:
        # Exhaust limit for email-a
        for _ in range(3):
            client.post(
                "/v1/auth/users/resend-verification",
                json={"email": "a@test.com"},
            )

        # email-b should still work
        resp = client.post(
            "/v1/auth/users/resend-verification",
            json={"email": "b@test.com"},
        )
        assert resp.status_code != 429


class TestMagicLinkRateLimit:
    """Magic link: 5 requests/min per email."""

    def test_magic_link_rate_limit_triggers_after_5(self, client: TestClient) -> None:
        email = "magic-limit@test.com"
        for i in range(5):
            resp = client.post(
                "/v1/auth/users/magic-link",
                json={"email": email},
            )
            # Will return 400 (no webhook configured) — not 429
            assert resp.status_code != 429, f"Rate limited too early on request {i + 1}"

        # 6th request should be rate-limited
        resp = client.post(
            "/v1/auth/users/magic-link",
            json={"email": email},
        )
        assert resp.status_code == 429
        body = resp.json()
        assert body["detail"] == _EXPECTED_429_ERROR


class TestPasswordResetRateLimit:
    """Password reset: 5 requests/min per email."""

    def test_password_reset_rate_limit_triggers_after_5(
        self, client: TestClient
    ) -> None:
        email = "reset-limit@test.com"
        for i in range(5):
            resp = client.post(
                "/v1/auth/users/reset-password",
                json={"email": email},
            )
            assert resp.status_code != 429, f"Rate limited too early on request {i + 1}"

        # 6th request should be rate-limited
        resp = client.post(
            "/v1/auth/users/reset-password",
            json={"email": email},
        )
        assert resp.status_code == 429
        body = resp.json()
        assert body["detail"] == _EXPECTED_429_ERROR


class TestMfaChallengeRateLimit:
    """MFA challenge: 5 attempts/min per ticket."""

    def test_mfa_challenge_rate_limit_triggers_after_5(
        self, client: TestClient
    ) -> None:
        # Use a fake ticket — it will fail auth but the rate limit fires first
        fake_ticket = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSJ9.fake.fake"
        for i in range(5):
            resp = client.post(
                "/v1/auth/users/mfa/challenge",
                json={"ticket": fake_ticket, "code": "000000"},
            )
            # Will return 401 (invalid ticket) — not 429
            assert resp.status_code != 429, f"Rate limited too early on request {i + 1}"

        # 6th request should be rate-limited
        resp = client.post(
            "/v1/auth/users/mfa/challenge",
            json={"ticket": fake_ticket, "code": "000000"},
        )
        assert resp.status_code == 429
        body = resp.json()
        assert body["detail"] == _EXPECTED_429_ERROR


class TestHealthCheckStillWorks:
    """Rate limiting doesn't break the health check."""

    def test_health_responds(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
