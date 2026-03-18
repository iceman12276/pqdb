"""Unit tests for MFA challenge rate limiting.

The MFA challenge endpoint must be rate-limited to prevent
brute-force TOTP code guessing.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI, HTTPException, Request

from pqdb_api.routes.mfa import _check_mfa_rate_limit


class TestMfaChallengeRateLimit:
    """MFA challenge rate limit: 5 attempts/min per ticket."""

    def test_allows_up_to_limit(self) -> None:
        app = FastAPI()
        scope: dict[str, Any] = {
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [],
            "query_string": b"",
            "root_path": "",
            "app": app,
        }
        request = Request(scope)

        # 5 requests should be allowed
        for _ in range(5):
            _check_mfa_rate_limit(request, ticket="ticket-abc")

    def test_blocks_after_limit(self) -> None:
        app = FastAPI()
        scope: dict[str, Any] = {
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [],
            "query_string": b"",
            "root_path": "",
            "app": app,
        }
        request = Request(scope)

        for _ in range(5):
            _check_mfa_rate_limit(request, ticket="ticket-xyz")

        with pytest.raises(HTTPException) as exc_info:
            _check_mfa_rate_limit(request, ticket="ticket-xyz")

        assert exc_info.value.status_code == 429
        detail = exc_info.value.detail
        assert detail == {
            "error": {
                "code": "rate_limited",
                "message": "Too many requests. Try again later.",
            }
        }

    def test_different_tickets_have_separate_limits(self) -> None:
        app = FastAPI()
        scope: dict[str, Any] = {
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [],
            "query_string": b"",
            "root_path": "",
            "app": app,
        }
        request = Request(scope)

        # Exhaust limit for ticket-a
        for _ in range(5):
            _check_mfa_rate_limit(request, ticket="ticket-a")

        # ticket-b should still work
        _check_mfa_rate_limit(request, ticket="ticket-b")

        # ticket-a should be blocked
        with pytest.raises(HTTPException):
            _check_mfa_rate_limit(request, ticket="ticket-a")
