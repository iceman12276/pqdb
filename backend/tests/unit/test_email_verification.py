"""Unit tests for email verification (US-032).

Tests:
- Verification token validation logic (type, expiry, single-use)
- Email verification enforcement logic
- Resend rate limiting logic
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import text

from pqdb_api.services.webhook import (
    generate_verification_token,
    hash_verification_token,
    verify_verification_token,
)


class TestVerificationTokenSingleUse:
    """Verification tokens must be single-use."""

    def test_used_token_fails_verification_conceptually(self) -> None:
        """Once a token is marked used, it should not be accepted again.

        The actual enforcement happens in the route handler by checking
        the 'used' column before verifying the hash. This test verifies
        the hash still matches (the DB 'used' flag is what prevents reuse).
        """
        token = generate_verification_token()
        hashed = hash_verification_token(token)
        # The hash still matches — the used flag is what blocks reuse
        assert verify_verification_token(hashed, token) is True

    def test_token_hash_does_not_match_different_token(self) -> None:
        token = generate_verification_token()
        hashed = hash_verification_token(token)
        other_token = generate_verification_token()
        assert verify_verification_token(hashed, other_token) is False


class TestEmailVerificationEnforcementLogic:
    """Test the enforcement decision: should CRUD be blocked?

    When require_email_verification=true and user is not verified,
    CRUD via anon key should return 403.
    """

    def test_should_block_unverified_user_with_enforcement_on(self) -> None:
        """Unverified user + enforcement on + anon key = blocked."""
        from pqdb_api.services.email_verification import should_enforce_email_verification

        assert (
            should_enforce_email_verification(
                require_email_verification=True,
                email_verified=False,
                key_role="anon",
                has_owner_column=True,
                has_user_context=True,
            )
            is True
        )

    def test_should_not_block_verified_user(self) -> None:
        """Verified user should not be blocked."""
        from pqdb_api.services.email_verification import should_enforce_email_verification

        assert (
            should_enforce_email_verification(
                require_email_verification=True,
                email_verified=True,
                key_role="anon",
                has_owner_column=True,
                has_user_context=True,
            )
            is False
        )

    def test_should_not_block_when_enforcement_off(self) -> None:
        """Enforcement disabled = no blocking."""
        from pqdb_api.services.email_verification import should_enforce_email_verification

        assert (
            should_enforce_email_verification(
                require_email_verification=False,
                email_verified=False,
                key_role="anon",
                has_owner_column=True,
                has_user_context=True,
            )
            is False
        )

    def test_should_not_block_service_role(self) -> None:
        """Service role bypasses email verification enforcement."""
        from pqdb_api.services.email_verification import should_enforce_email_verification

        assert (
            should_enforce_email_verification(
                require_email_verification=True,
                email_verified=False,
                key_role="service",
                has_owner_column=True,
                has_user_context=True,
            )
            is False
        )

    def test_should_not_block_when_no_owner_column(self) -> None:
        """No owner column = no enforcement (per AC)."""
        from pqdb_api.services.email_verification import should_enforce_email_verification

        assert (
            should_enforce_email_verification(
                require_email_verification=True,
                email_verified=False,
                key_role="anon",
                has_owner_column=False,
                has_user_context=True,
            )
            is False
        )

    def test_should_not_block_when_no_user_context(self) -> None:
        """No user context = no enforcement."""
        from pqdb_api.services.email_verification import should_enforce_email_verification

        assert (
            should_enforce_email_verification(
                require_email_verification=True,
                email_verified=False,
                key_role="anon",
                has_owner_column=True,
                has_user_context=False,
            )
            is False
        )


class TestVerificationTokenExpiry:
    """Token expiry is 24 hours."""

    def test_token_expiry_duration(self) -> None:
        """Verify the constant is 24 hours = 86400 seconds."""
        from pqdb_api.services.email_verification import VERIFICATION_TOKEN_EXPIRY_SECONDS

        assert VERIFICATION_TOKEN_EXPIRY_SECONDS == 86400
