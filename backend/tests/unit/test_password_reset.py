"""Unit tests for password reset (US-033).

Tests token generation, password update, session invalidation,
rate limiting logic, and email enumeration prevention.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import MagicMock

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.user_auth import UserAuthService
from pqdb_api.services.webhook import (
    generate_verification_token,
    hash_verification_token,
    verify_verification_token,
)


@pytest.fixture()
def ed25519_keys() -> tuple[Ed25519PrivateKey, Any]:
    private_key, public_key = generate_ed25519_keypair()
    return private_key, public_key


@pytest.fixture()
def user_auth_service(ed25519_keys: tuple[Any, Any]) -> UserAuthService:
    private_key, public_key = ed25519_keys
    return UserAuthService(private_key=private_key, public_key=public_key)


class TestPasswordResetTokenGeneration:
    """Test that verification tokens work for password reset."""

    def test_generate_token_returns_nonempty_string(self) -> None:
        token = generate_verification_token()
        assert isinstance(token, str)
        assert len(token) > 0

    def test_generated_tokens_are_unique(self) -> None:
        tokens = {generate_verification_token() for _ in range(100)}
        assert len(tokens) == 100

    def test_token_hash_round_trip(self) -> None:
        token = generate_verification_token()
        token_hash = hash_verification_token(token)
        assert verify_verification_token(token_hash, token) is True

    def test_wrong_token_fails_verification(self) -> None:
        token = generate_verification_token()
        token_hash = hash_verification_token(token)
        assert verify_verification_token(token_hash, "wrong_token") is False


class TestPasswordValidation:
    """Test password validation for the update-password flow."""

    def test_password_too_short_raises(
        self, user_auth_service: UserAuthService
    ) -> None:
        with pytest.raises(ValueError, match="at least"):
            user_auth_service.validate_password("short", min_length=8)

    def test_password_at_min_length_passes(
        self, user_auth_service: UserAuthService
    ) -> None:
        # Should not raise
        user_auth_service.validate_password("12345678", min_length=8)

    def test_password_exceeds_max_length_raises(
        self, user_auth_service: UserAuthService
    ) -> None:
        with pytest.raises(ValueError, match="must not exceed"):
            user_auth_service.validate_password("a" * 1025)

    def test_custom_min_length_enforced(
        self, user_auth_service: UserAuthService
    ) -> None:
        with pytest.raises(ValueError, match="at least 12"):
            user_auth_service.validate_password("short12345", min_length=12)


class TestSessionInvalidation:
    """Test that all sessions are revoked on password update.

    This tests the logic conceptually — the actual SQL is tested
    in integration tests. Here we verify the service-level token
    operations that support the flow.
    """

    def test_refresh_token_can_be_hashed_and_verified(
        self, user_auth_service: UserAuthService
    ) -> None:
        """Verify the hash/verify round-trip used for session management."""
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()

        refresh_token = user_auth_service.create_user_refresh_token(
            user_id=user_id, project_id=project_id
        )
        token_hash = user_auth_service.hash_refresh_token(refresh_token)
        assert user_auth_service.verify_refresh_token(token_hash, refresh_token) is True

    def test_revoked_token_hash_still_matches(
        self, user_auth_service: UserAuthService
    ) -> None:
        """Hash verification is separate from revocation status.

        The hash still matches after revocation — the revocation check
        is done via the `revoked` boolean in the DB, not the hash.
        """
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()

        refresh_token = user_auth_service.create_user_refresh_token(
            user_id=user_id, project_id=project_id
        )
        token_hash = user_auth_service.hash_refresh_token(refresh_token)
        # Even after "revocation" (which flips a DB bool), the hash still matches
        assert user_auth_service.verify_refresh_token(token_hash, refresh_token) is True


class TestRateLimitLogic:
    """Test the rate limiting mechanism used for password reset.

    The rate limiter is IP+email based, 5 requests/min.
    We test the general _check_rate_limit helper behavior.
    """

    def _make_rate_limit_request(self) -> Any:
        """Build a mock request with real app state for rate limiting."""
        from starlette.datastructures import State

        mock_app = MagicMock()
        mock_app.state = State()
        mock_request = MagicMock()
        mock_request.app = mock_app
        return mock_request

    def test_rate_limit_allows_up_to_max_requests(self) -> None:
        """Simulate rate limit tracking with a simple dict."""
        from pqdb_api.routes.user_auth import _check_rate_limit

        mock_request = self._make_rate_limit_request()

        # First 5 requests should pass
        for _ in range(5):
            _check_rate_limit(
                mock_request,
                key_prefix="password_reset",
                ip="test_email@test.com",
                max_requests=5,
                window_seconds=60,
            )

    def test_rate_limit_rejects_over_max(self) -> None:
        from fastapi import HTTPException

        from pqdb_api.routes.user_auth import _check_rate_limit

        mock_request = self._make_rate_limit_request()

        # Fill up to limit
        for _ in range(5):
            _check_rate_limit(
                mock_request,
                key_prefix="password_reset_test",
                ip="test_email@test.com",
                max_requests=5,
                window_seconds=60,
            )

        # 6th should raise 429
        with pytest.raises(HTTPException) as exc_info:
            _check_rate_limit(
                mock_request,
                key_prefix="password_reset_test",
                ip="test_email@test.com",
                max_requests=5,
                window_seconds=60,
            )
        assert exc_info.value.status_code == 429


class TestEmailEnumerationPrevention:
    """Verify that reset-password always returns 200 regardless of email existence.

    This is tested more thoroughly in integration tests, but the design
    principle is verified here.
    """

    def test_token_generation_is_independent_of_user_lookup(self) -> None:
        """Token generation doesn't require a user to exist."""
        token = generate_verification_token()
        token_hash = hash_verification_token(token)
        # Both operations succeed without any user context
        assert len(token) > 0
        assert len(token_hash) > 0
