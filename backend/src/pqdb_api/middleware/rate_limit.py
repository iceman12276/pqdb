"""Rate limiting middleware.

Applies sliding-window rate limits to CRUD and auth endpoints.
- /v1/db/* → per-project limiting (keyed by project_id from apikey middleware)
- /v1/auth/signup, /v1/auth/login, /v1/auth/refresh → per-IP limiting

Returns X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers
on all rate-limited responses (both allowed and denied).
"""

from __future__ import annotations

import math

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.types import ASGIApp

from pqdb_api.services.rate_limiter import RateLimitResult, RateLimiter

# Developer auth paths that get per-IP rate limiting
_AUTH_RATE_LIMITED_PREFIXES = (
    "/v1/auth/signup",
    "/v1/auth/login",
    "/v1/auth/refresh",
)

# CRUD paths that get per-project rate limiting
_CRUD_PREFIX = "/v1/db/"


def _get_client_ip(request: Request) -> str:
    """Extract client IP for rate limiting.

    Uses request.client.host only — does NOT trust X-Forwarded-For
    because it can be spoofed by clients to bypass rate limiting.
    """
    client = request.client
    if client:
        return client.host
    return "unknown"


def _add_rate_limit_headers(
    response: Response, result: RateLimitResult
) -> None:
    """Add X-RateLimit-* headers to a response."""
    response.headers["X-RateLimit-Limit"] = str(result.limit)
    response.headers["X-RateLimit-Remaining"] = str(result.remaining)
    response.headers["X-RateLimit-Reset"] = str(math.ceil(result.reset_after))


def _rate_limited_response(result: RateLimitResult) -> JSONResponse:
    """Build a 429 response with rate limit headers."""
    resp = JSONResponse(
        status_code=429,
        content={
            "error": {
                "code": "rate_limited",
                "message": "Too many requests. Try again later.",
            }
        },
    )
    _add_rate_limit_headers(resp, result)
    return resp


class RateLimitMiddleware(BaseHTTPMiddleware):
    """ASGI middleware for rate limiting CRUD and auth endpoints."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        path = request.url.path

        # Check auth rate limit (per-IP)
        if any(path.startswith(p) for p in _AUTH_RATE_LIMITED_PREFIXES):
            limiter: RateLimiter | None = getattr(
                request.app.state, "auth_rate_limiter", None
            )
            if limiter is not None:
                ip = _get_client_ip(request)
                result = limiter.check(ip)
                if not result.allowed:
                    return _rate_limited_response(result)
                response = await call_next(request)
                _add_rate_limit_headers(response, result)
                return response

        # Check CRUD rate limit (per-project, keyed by apikey header)
        if path.startswith(_CRUD_PREFIX):
            limiter = getattr(
                request.app.state, "crud_rate_limiter", None
            )
            if limiter is not None:
                # Use apikey header as the rate limit key.
                # Each apikey maps 1:1 to a project, so keying by apikey
                # is functionally equivalent to per-project limiting.
                apikey = request.headers.get("apikey", "")
                if apikey:
                    result = limiter.check(apikey)
                    if not result.allowed:
                        return _rate_limited_response(result)
                    response = await call_next(request)
                    _add_rate_limit_headers(response, result)
                    return response

        # Not rate-limited
        return await call_next(request)
