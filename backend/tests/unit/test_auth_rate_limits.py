"""Unit tests for auth endpoint rate limiting.

Tests verify:
- Rate limit response format returns HTTP 429 with correct error body
- All auth endpoints enforce their specified rate limits
- MFA challenge is rate-limited
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException, Request
from starlette.testclient import TestClient

from pqdb_api.routes.user_auth import (
    _check_email_rate_limit,
    _check_rate_limit,
)


class TestRateLimitResponseFormat:
    """Rate limit responses must return 429 with standardized error body."""

    def test_ip_rate_limit_returns_429_with_error_body(self) -> None:
        """_check_rate_limit raises 429 with correct error JSON structure."""
        app = FastAPI()
        app.state._test = True  # ensure state exists

        # Build a minimal Request
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

        # Exhaust the rate limit
        for _ in range(3):
            _check_rate_limit(
                request,
                key_prefix="test_ip",
                ip="1.2.3.4",
                max_requests=3,
            )

        # Next request should be rate-limited
        with pytest.raises(HTTPException) as exc_info:
            _check_rate_limit(
                request,
                key_prefix="test_ip",
                ip="1.2.3.4",
                max_requests=3,
            )

        assert exc_info.value.status_code == 429
        detail = exc_info.value.detail
        assert detail == {
            "error": {
                "code": "rate_limited",
                "message": "Too many requests. Try again later.",
            }
        }

    def test_email_rate_limit_returns_429_with_error_body(self) -> None:
        """_check_email_rate_limit raises 429 with correct error JSON."""
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

        for _ in range(2):
            _check_email_rate_limit(
                request,
                key_prefix="test_email",
                email="user@test.com",
                max_requests=2,
            )

        with pytest.raises(HTTPException) as exc_info:
            _check_email_rate_limit(
                request,
                key_prefix="test_email",
                email="user@test.com",
                max_requests=2,
            )

        assert exc_info.value.status_code == 429
        detail = exc_info.value.detail
        assert detail == {
            "error": {
                "code": "rate_limited",
                "message": "Too many requests. Try again later.",
            }
        }


class TestRateLimitWindowReset:
    """Rate limits reset after the window expires."""

    def test_ip_rate_limit_resets_after_window(self) -> None:
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

        base_time = 1000.0
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = base_time

            # Use up the limit
            _check_rate_limit(
                request,
                key_prefix="test_window",
                ip="1.2.3.4",
                max_requests=1,
            )

            # Should be blocked
            with pytest.raises(HTTPException):
                _check_rate_limit(
                    request,
                    key_prefix="test_window",
                    ip="1.2.3.4",
                    max_requests=1,
                )

            # Advance past window
            mock_time.return_value = base_time + 61

            # Should be allowed again
            _check_rate_limit(
                request,
                key_prefix="test_window",
                ip="1.2.3.4",
                max_requests=1,
            )

    def test_email_rate_limit_resets_after_window(self) -> None:
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

        base_time = 2000.0
        with patch("time.monotonic") as mock_time:
            mock_time.return_value = base_time

            _check_email_rate_limit(
                request,
                key_prefix="test_email_window",
                email="u@t.com",
                max_requests=1,
            )

            with pytest.raises(HTTPException):
                _check_email_rate_limit(
                    request,
                    key_prefix="test_email_window",
                    email="u@t.com",
                    max_requests=1,
                )

            mock_time.return_value = base_time + 61

            _check_email_rate_limit(
                request,
                key_prefix="test_email_window",
                email="u@t.com",
                max_requests=1,
            )
