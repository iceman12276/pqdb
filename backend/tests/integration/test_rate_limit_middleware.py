"""Integration tests for rate limit middleware (US-PRE-2).

Boots the real FastAPI app with real Postgres and verifies:
- CRUD endpoints rate limited per project (1000/min default, override via env)
- Developer auth endpoints rate limited per IP (20/min default)
- Rate limit headers on all rate-limited responses
- Health check not affected
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

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
from pqdb_api.middleware.rate_limit import RateLimitMiddleware
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _make_rate_limit_app(
    test_db_url: str,
    test_db_name: str,
    *,
    crud_max: int = 1000,
    auth_max: int = 20,
) -> FastAPI:
    """Build a test FastAPI app with rate limit middleware."""
    private_key, public_key = generate_ed25519_keypair()

    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"
    mock_vault = MagicMock(spec=VaultClient)

    settings = Settings(
        database_url=test_db_url,
        superuser_dsn="postgresql://test:test@localhost/test",
        rate_limit_crud=crud_max,
        rate_limit_auth=auth_max,
    )

    fake_project_id = uuid.uuid4()
    fake_context = ProjectContext(
        project_id=fake_project_id,
        key_role="service",
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
        app.state.crud_rate_limiter = RateLimiter(
            max_requests=crud_max, window_seconds=60
        )
        app.state.auth_rate_limiter = RateLimiter(
            max_requests=auth_max, window_seconds=60
        )
        app.state.settings = settings
        yield
        await platform_engine.dispose()
        await project_engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(RateLimitMiddleware)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(db_router)
    return app


# ---------------------------------------------------------------------------
# Developer auth rate limiting
# ---------------------------------------------------------------------------
class TestDeveloperAuthRateLimit:
    """Developer auth endpoints: /v1/auth/signup, /v1/auth/login, /v1/auth/refresh."""

    def test_signup_returns_rate_limit_headers(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, auth_max=20)
        with TestClient(app) as client:
            resp = client.post(
                "/v1/auth/signup",
                json={"email": "dev@test.com", "password": "testpass123"},
            )
            assert "x-ratelimit-limit" in resp.headers
            assert resp.headers["x-ratelimit-limit"] == "20"
            assert "x-ratelimit-remaining" in resp.headers
            assert "x-ratelimit-reset" in resp.headers

    def test_login_returns_rate_limit_headers(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, auth_max=20)
        with TestClient(app) as client:
            resp = client.post(
                "/v1/auth/login",
                json={"email": "dev@test.com", "password": "wrong"},
            )
            assert "x-ratelimit-limit" in resp.headers
            assert resp.headers["x-ratelimit-limit"] == "20"

    def test_refresh_returns_rate_limit_headers(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, auth_max=20)
        with TestClient(app) as client:
            resp = client.post(
                "/v1/auth/refresh",
                json={"refresh_token": "fake"},
            )
            assert "x-ratelimit-limit" in resp.headers
            assert resp.headers["x-ratelimit-limit"] == "20"

    def test_auth_rate_limit_triggers_after_threshold(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, auth_max=3)
        with TestClient(app) as client:
            for i in range(3):
                resp = client.post(
                    "/v1/auth/signup",
                    json={
                        "email": f"dev{i}@test.com",
                        "password": "testpass123",
                    },
                )
                assert resp.status_code != 429, (
                    f"Rate limited too early on request {i + 1}"
                )

            # 4th request should be rate limited
            resp = client.post(
                "/v1/auth/signup",
                json={"email": "extra@test.com", "password": "testpass123"},
            )
            assert resp.status_code == 429
            body = resp.json()
            assert body["error"]["code"] == "rate_limited"
            # Headers present on 429
            assert "x-ratelimit-limit" in resp.headers
            assert resp.headers["x-ratelimit-remaining"] == "0"

    def test_auth_rate_limit_shared_across_auth_endpoints(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        """signup + login share the same IP bucket."""
        app = _make_rate_limit_app(test_db_url, test_db_name, auth_max=2)
        with TestClient(app) as client:
            client.post(
                "/v1/auth/signup",
                json={"email": "dev1@test.com", "password": "testpass123"},
            )
            client.post(
                "/v1/auth/login",
                json={"email": "dev1@test.com", "password": "wrong"},
            )
            # 3rd request blocked
            resp = client.post(
                "/v1/auth/refresh",
                json={"refresh_token": "fake"},
            )
            assert resp.status_code == 429


# ---------------------------------------------------------------------------
# CRUD rate limiting
# ---------------------------------------------------------------------------
class TestCrudRateLimit:
    """CRUD endpoints: /v1/db/* keyed by apikey header."""

    def test_crud_returns_rate_limit_headers(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, crud_max=100)
        with TestClient(app) as client:
            resp = client.get(
                "/v1/db/health",
                headers={"apikey": "pqdb_service_testkey123"},
            )
            assert resp.status_code == 200
            assert "x-ratelimit-limit" in resp.headers
            assert resp.headers["x-ratelimit-limit"] == "100"
            assert "x-ratelimit-remaining" in resp.headers
            assert "x-ratelimit-reset" in resp.headers

    def test_crud_rate_limit_triggers_after_threshold(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, crud_max=3)
        with TestClient(app) as client:
            apikey = "pqdb_service_testkey456"
            for i in range(3):
                resp = client.get(
                    "/v1/db/health",
                    headers={"apikey": apikey},
                )
                assert resp.status_code != 429, (
                    f"Rate limited too early on request {i + 1}"
                )

            # 4th request should be rate limited
            resp = client.get(
                "/v1/db/health",
                headers={"apikey": apikey},
            )
            assert resp.status_code == 429
            body = resp.json()
            assert body["error"]["code"] == "rate_limited"
            assert "x-ratelimit-limit" in resp.headers

    def test_different_apikeys_have_separate_limits(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, crud_max=1)
        with TestClient(app) as client:
            r1 = client.get(
                "/v1/db/health",
                headers={"apikey": "pqdb_service_key_a"},
            )
            assert r1.status_code == 200

            r2 = client.get(
                "/v1/db/health",
                headers={"apikey": "pqdb_service_key_b"},
            )
            assert r2.status_code == 200

            # key_a now blocked
            r3 = client.get(
                "/v1/db/health",
                headers={"apikey": "pqdb_service_key_a"},
            )
            assert r3.status_code == 429


# ---------------------------------------------------------------------------
# Health check unaffected
# ---------------------------------------------------------------------------
class TestHealthCheckUnaffected:
    """Health check should not be rate limited."""

    def test_health_no_rate_limit_headers(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        app = _make_rate_limit_app(test_db_url, test_db_name, auth_max=1)
        with TestClient(app) as client:
            resp = client.get("/health")
            assert resp.status_code == 200
            assert "x-ratelimit-limit" not in resp.headers

    def test_health_works_when_auth_exhausted(
        self, test_db_url: str, test_db_name: str
    ) -> None:
        """Even when auth rate limit is exhausted, health still responds."""
        app = _make_rate_limit_app(test_db_url, test_db_name, auth_max=1)
        with TestClient(app) as client:
            # Exhaust auth limit
            client.post(
                "/v1/auth/signup",
                json={"email": "dev@test.com", "password": "testpass123"},
            )
            resp = client.post(
                "/v1/auth/signup",
                json={"email": "dev2@test.com", "password": "testpass123"},
            )
            assert resp.status_code == 429

            # Health still works
            resp = client.get("/health")
            assert resp.status_code == 200
