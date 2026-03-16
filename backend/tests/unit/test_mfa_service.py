"""Unit tests for MFA/TOTP service (US-039).

Tests TOTP generation, validation with time drift, recovery code
hashing, mfa_ticket JWT creation, enrollment/unenrollment logic.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pyotp
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pqdb_api.services.auth import (
    JWT_ALGORITHM,
    generate_ed25519_keypair,
)
from pqdb_api.services.mfa import MFAService


@pytest.fixture()
def ed25519_keys() -> tuple[Ed25519PrivateKey, Any]:
    private_key, public_key = generate_ed25519_keypair()
    return private_key, public_key


@pytest.fixture()
def mfa_service(ed25519_keys: tuple[Any, Any]) -> MFAService:
    private_key, public_key = ed25519_keys
    return MFAService(private_key=private_key, public_key=public_key)


class TestGenerateTOTPSecret:
    """Test TOTP secret generation."""

    def test_generates_base32_encoded_secret(self, mfa_service: MFAService) -> None:
        secret = mfa_service.generate_totp_secret()
        # pyotp uses base32 encoding, should be valid base32
        assert len(secret) == 32  # 20 bytes -> 32 base32 chars

    def test_generates_unique_secrets(self, mfa_service: MFAService) -> None:
        s1 = mfa_service.generate_totp_secret()
        s2 = mfa_service.generate_totp_secret()
        assert s1 != s2


class TestGenerateQRUri:
    """Test TOTP provisioning URI generation."""

    def test_generates_valid_otpauth_uri(self, mfa_service: MFAService) -> None:
        secret = mfa_service.generate_totp_secret()
        uri = mfa_service.generate_qr_uri(
            secret=secret, email="user@example.com", issuer="pqdb"
        )
        assert uri.startswith("otpauth://totp/")
        assert "user%40example.com" in uri or "user@example.com" in uri
        assert "pqdb" in uri
        assert secret in uri


class TestVerifyTOTP:
    """Test TOTP code validation with time drift tolerance."""

    def test_valid_current_code_accepted(self, mfa_service: MFAService) -> None:
        secret = mfa_service.generate_totp_secret()
        totp = pyotp.TOTP(secret)
        code = totp.now()
        assert mfa_service.verify_totp(secret, code) is True

    def test_invalid_code_rejected(self, mfa_service: MFAService) -> None:
        secret = mfa_service.generate_totp_secret()
        assert mfa_service.verify_totp(secret, "000000") is False

    def test_previous_step_code_accepted(self, mfa_service: MFAService) -> None:
        """±1 step tolerance: code from 30 seconds ago should be accepted."""
        secret = mfa_service.generate_totp_secret()
        totp = pyotp.TOTP(secret)
        # Generate code for previous time step
        prev_code = totp.at(datetime.now(UTC) - timedelta(seconds=30))
        assert mfa_service.verify_totp(secret, prev_code) is True

    def test_next_step_code_accepted(self, mfa_service: MFAService) -> None:
        """±1 step tolerance: code from 30 seconds in future should be accepted."""
        secret = mfa_service.generate_totp_secret()
        totp = pyotp.TOTP(secret)
        next_code = totp.at(datetime.now(UTC) + timedelta(seconds=30))
        assert mfa_service.verify_totp(secret, next_code) is True

    def test_old_code_rejected(self, mfa_service: MFAService) -> None:
        """Code from >1 step ago should be rejected."""
        secret = mfa_service.generate_totp_secret()
        totp = pyotp.TOTP(secret)
        old_code = totp.at(datetime.now(UTC) - timedelta(seconds=90))
        assert mfa_service.verify_totp(secret, old_code) is False


class TestRecoveryCodes:
    """Test recovery code generation and hashing."""

    def test_generates_10_recovery_codes(self, mfa_service: MFAService) -> None:
        codes = mfa_service.generate_recovery_codes()
        assert len(codes) == 10

    def test_recovery_codes_are_8_chars(self, mfa_service: MFAService) -> None:
        codes = mfa_service.generate_recovery_codes()
        for code in codes:
            assert len(code) == 8

    def test_recovery_codes_are_unique(self, mfa_service: MFAService) -> None:
        codes = mfa_service.generate_recovery_codes()
        assert len(set(codes)) == 10

    def test_hash_recovery_code_returns_argon2(self, mfa_service: MFAService) -> None:
        hashed = mfa_service.hash_recovery_code("abcd1234")
        assert hashed.startswith("$argon2id$")

    def test_verify_recovery_code_matches(self, mfa_service: MFAService) -> None:
        code = "abcd1234"
        hashed = mfa_service.hash_recovery_code(code)
        assert mfa_service.verify_recovery_code(hashed, code) is True

    def test_verify_recovery_code_wrong_code(self, mfa_service: MFAService) -> None:
        hashed = mfa_service.hash_recovery_code("abcd1234")
        assert mfa_service.verify_recovery_code(hashed, "wrong123") is False


class TestMFATicketJWT:
    """Test MFA challenge ticket JWT creation and validation."""

    def test_create_mfa_ticket(
        self, mfa_service: MFAService, ed25519_keys: tuple[Any, Any]
    ) -> None:
        _, public_key = ed25519_keys
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        ticket = mfa_service.create_mfa_ticket(user_id=user_id, project_id=project_id)
        payload = jwt.decode(ticket, public_key, algorithms=[JWT_ALGORITHM])
        assert payload["sub"] == str(user_id)
        assert payload["project_id"] == str(project_id)
        assert payload["type"] == "mfa_challenge"

    def test_mfa_ticket_expires_in_5_minutes(
        self, mfa_service: MFAService, ed25519_keys: tuple[Any, Any]
    ) -> None:
        _, public_key = ed25519_keys
        ticket = mfa_service.create_mfa_ticket(
            user_id=uuid.uuid4(), project_id=uuid.uuid4()
        )
        payload = jwt.decode(ticket, public_key, algorithms=[JWT_ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        iat = datetime.fromtimestamp(payload["iat"], tz=UTC)
        delta = exp - iat
        assert abs(delta.total_seconds() - 300) < 2  # 5 min = 300s

    def test_decode_mfa_ticket(self, mfa_service: MFAService) -> None:
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()
        ticket = mfa_service.create_mfa_ticket(user_id=user_id, project_id=project_id)
        payload = mfa_service.decode_mfa_ticket(ticket)
        assert payload["sub"] == str(user_id)
        assert payload["type"] == "mfa_challenge"

    def test_decode_mfa_ticket_wrong_type_raises(
        self, mfa_service: MFAService, ed25519_keys: tuple[Any, Any]
    ) -> None:
        """Non-mfa_challenge tokens should be rejected."""
        private_key, _ = ed25519_keys
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "type": "user_access",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        }
        token = jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)
        with pytest.raises(ValueError, match="Invalid ticket type"):
            mfa_service.decode_mfa_ticket(token)

    def test_decode_expired_ticket_raises(
        self, mfa_service: MFAService, ed25519_keys: tuple[Any, Any]
    ) -> None:
        private_key, _ = ed25519_keys
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(uuid.uuid4()),
            "type": "mfa_challenge",
            "iat": now - timedelta(minutes=10),
            "exp": now - timedelta(minutes=5),
        }
        token = jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)
        with pytest.raises(jwt.ExpiredSignatureError):
            mfa_service.decode_mfa_ticket(token)
