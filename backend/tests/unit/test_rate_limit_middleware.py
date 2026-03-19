"""Unit tests for rate limit middleware.

Tests the middleware class in isolation using a minimal FastAPI app.
Verifies header format, per-IP vs per-project keying, and env var config.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from pqdb_api.middleware.rate_limit import RateLimitMiddleware
from pqdb_api.services.rate_limiter import RateLimiter


def _make_test_app(
    *,
    crud_limiter: RateLimiter | None = None,
    auth_limiter: RateLimiter | None = None,
) -> FastAPI:
    """Build a minimal app with rate limit middleware for testing."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if crud_limiter is not None:
            app.state.crud_rate_limiter = crud_limiter
        if auth_limiter is not None:
            app.state.auth_rate_limiter = auth_limiter
        yield

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(RateLimitMiddleware)

    @app.get("/v1/db/test/select")
    async def db_endpoint(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    @app.get("/v1/auth/signup")
    async def auth_signup(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    @app.get("/v1/auth/login")
    async def auth_login(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    @app.get("/v1/auth/refresh")
    async def auth_refresh(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    @app.get("/v1/projects")
    async def projects(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    return app


class TestRateLimitHeaders:
    """Rate limit headers on auth endpoints."""

    def test_auth_headers_present(self) -> None:
        limiter = RateLimiter(max_requests=5, window_seconds=60)
        app = _make_test_app(auth_limiter=limiter)
        with TestClient(app) as client:
            resp = client.get("/v1/auth/signup")
            assert resp.status_code == 200
            assert "x-ratelimit-limit" in resp.headers
            assert "x-ratelimit-remaining" in resp.headers
            assert "x-ratelimit-reset" in resp.headers
            assert resp.headers["x-ratelimit-limit"] == "5"
            assert resp.headers["x-ratelimit-remaining"] == "4"

    def test_auth_remaining_decreases(self) -> None:
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        app = _make_test_app(auth_limiter=limiter)
        with TestClient(app) as client:
            r1 = client.get("/v1/auth/signup")
            assert r1.headers["x-ratelimit-remaining"] == "2"

            r2 = client.get("/v1/auth/signup")
            assert r2.headers["x-ratelimit-remaining"] == "1"

            r3 = client.get("/v1/auth/signup")
            assert r3.headers["x-ratelimit-remaining"] == "0"

    def test_auth_429_when_exceeded(self) -> None:
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        app = _make_test_app(auth_limiter=limiter)
        with TestClient(app) as client:
            client.get("/v1/auth/signup")
            client.get("/v1/auth/signup")

            resp = client.get("/v1/auth/signup")
            assert resp.status_code == 429
            body = resp.json()
            assert body["error"]["code"] == "rate_limited"
            # Headers still present on 429
            assert "x-ratelimit-limit" in resp.headers
            assert resp.headers["x-ratelimit-remaining"] == "0"

    def test_reset_header_is_integer_seconds(self) -> None:
        limiter = RateLimiter(max_requests=10, window_seconds=60)
        app = _make_test_app(auth_limiter=limiter)
        with TestClient(app) as client:
            resp = client.get("/v1/auth/signup")
            reset = int(resp.headers["x-ratelimit-reset"])
            # math.ceil() can round up by 1s depending on exact timing
            assert 0 < reset <= 61


class TestPerIPKeying:
    """Auth endpoints use per-IP keying."""

    def test_all_auth_endpoints_share_ip_bucket(self) -> None:
        """signup, login, refresh share the same per-IP bucket."""
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        app = _make_test_app(auth_limiter=limiter)
        with TestClient(app) as client:
            r1 = client.get("/v1/auth/signup")
            assert r1.status_code == 200
            assert r1.headers["x-ratelimit-remaining"] == "2"

            r2 = client.get("/v1/auth/login")
            assert r2.status_code == 200
            assert r2.headers["x-ratelimit-remaining"] == "1"

            r3 = client.get("/v1/auth/refresh")
            assert r3.status_code == 200
            assert r3.headers["x-ratelimit-remaining"] == "0"

            # Fourth request blocked
            r4 = client.get("/v1/auth/signup")
            assert r4.status_code == 429


class TestCrudRateLimiting:
    """CRUD endpoints use per-project (apikey) keying."""

    def test_crud_headers_present_with_apikey(self) -> None:
        limiter = RateLimiter(max_requests=100, window_seconds=60)
        app = _make_test_app(crud_limiter=limiter)
        with TestClient(app) as client:
            resp = client.get(
                "/v1/db/test/select",
                headers={"apikey": "pqdb_anon_test123"},
            )
            assert resp.status_code == 200
            assert "x-ratelimit-limit" in resp.headers
            assert resp.headers["x-ratelimit-limit"] == "100"
            assert resp.headers["x-ratelimit-remaining"] == "99"

    def test_crud_429_when_exceeded(self) -> None:
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        app = _make_test_app(crud_limiter=limiter)
        with TestClient(app) as client:
            apikey = "pqdb_anon_test456"
            client.get("/v1/db/test/select", headers={"apikey": apikey})
            client.get("/v1/db/test/select", headers={"apikey": apikey})

            resp = client.get("/v1/db/test/select", headers={"apikey": apikey})
            assert resp.status_code == 429
            body = resp.json()
            assert body["error"]["code"] == "rate_limited"

    def test_different_apikeys_have_separate_limits(self) -> None:
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        app = _make_test_app(crud_limiter=limiter)
        with TestClient(app) as client:
            r1 = client.get(
                "/v1/db/test/select",
                headers={"apikey": "pqdb_anon_key_a"},
            )
            assert r1.status_code == 200

            r2 = client.get(
                "/v1/db/test/select",
                headers={"apikey": "pqdb_anon_key_b"},
            )
            assert r2.status_code == 200

            # key_a should now be blocked
            r3 = client.get(
                "/v1/db/test/select",
                headers={"apikey": "pqdb_anon_key_a"},
            )
            assert r3.status_code == 429

    def test_no_apikey_skips_rate_limiting(self) -> None:
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        app = _make_test_app(crud_limiter=limiter)
        with TestClient(app) as client:
            # No apikey header — middleware skips rate limiting
            resp = client.get("/v1/db/test/select")
            assert "x-ratelimit-limit" not in resp.headers


class TestNoRateLimitOnOtherRoutes:
    """Non-rate-limited routes have no rate limit headers."""

    def test_health_no_rate_limit_headers(self) -> None:
        app = _make_test_app(
            auth_limiter=RateLimiter(max_requests=1, window_seconds=60),
        )
        with TestClient(app) as client:
            resp = client.get("/health")
            assert resp.status_code == 200
            assert "x-ratelimit-limit" not in resp.headers

    def test_projects_no_rate_limit_headers(self) -> None:
        app = _make_test_app(
            auth_limiter=RateLimiter(max_requests=1, window_seconds=60),
        )
        with TestClient(app) as client:
            resp = client.get("/v1/projects")
            assert resp.status_code == 200
            assert "x-ratelimit-limit" not in resp.headers


class TestEnvVarConfig:
    """Environment variable overrides for rate limits."""

    def test_settings_default_crud(self) -> None:
        from pqdb_api.config import Settings

        s = Settings()
        assert s.rate_limit_crud == 1000

    def test_settings_default_auth(self) -> None:
        from pqdb_api.config import Settings

        s = Settings()
        assert s.rate_limit_auth == 20

    def test_settings_env_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from pqdb_api.config import Settings

        monkeypatch.setenv("PQDB_RATE_LIMIT_CRUD", "500")
        monkeypatch.setenv("PQDB_RATE_LIMIT_AUTH", "10")
        s = Settings()
        assert s.rate_limit_crud == 500
        assert s.rate_limit_auth == 10
