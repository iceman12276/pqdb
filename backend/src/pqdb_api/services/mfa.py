"""MFA/TOTP service (US-039).

Handles TOTP secret generation, validation with ±1 step tolerance,
recovery code generation/hashing, and MFA challenge ticket JWTs.
Uses pyotp for RFC 6238 TOTP and argon2id for recovery code hashing.
"""

from __future__ import annotations

import secrets
import string
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from pqdb_api.services.auth import _build_mldsa65_token, decode_token

MFA_TICKET_EXPIRE_MINUTES = 5
RECOVERY_CODE_COUNT = 10
RECOVERY_CODE_LENGTH = 8

_hasher = PasswordHasher()


class MFAService:
    """MFA/TOTP operations.

    Uses the same ML-DSA-65 key pair as auth for signing
    MFA challenge tickets.
    """

    def __init__(
        self,
        private_key: bytes,
        public_key: bytes,
    ) -> None:
        self._private_key = private_key
        self._public_key = public_key

    def generate_totp_secret(self) -> str:
        """Generate a 20-byte TOTP secret (RFC 6238), base32-encoded."""
        return pyotp.random_base32(length=32)

    def generate_qr_uri(
        self,
        *,
        secret: str,
        email: str,
        issuer: str = "pqdb",
    ) -> str:
        """Generate an otpauth:// URI for QR code provisioning."""
        totp = pyotp.TOTP(secret)
        return totp.provisioning_uri(name=email, issuer_name=issuer)

    def verify_totp(self, secret: str, code: str) -> bool:
        """Verify a TOTP code with ±1 step (30s) tolerance."""
        totp = pyotp.TOTP(secret)
        return totp.verify(code, valid_window=1)

    def generate_recovery_codes(self) -> list[str]:
        """Generate 10 unique 8-character recovery codes."""
        alphabet = string.ascii_lowercase + string.digits
        codes: list[str] = []
        seen: set[str] = set()
        while len(codes) < RECOVERY_CODE_COUNT:
            code = "".join(
                secrets.choice(alphabet) for _ in range(RECOVERY_CODE_LENGTH)
            )
            if code not in seen:
                seen.add(code)
                codes.append(code)
        return codes

    def hash_recovery_code(self, code: str) -> str:
        """Hash a recovery code using argon2id."""
        return _hasher.hash(code)

    def verify_recovery_code(self, code_hash: str, code: str) -> bool:
        """Verify a recovery code against its argon2id hash."""
        try:
            return _hasher.verify(code_hash, code)
        except VerifyMismatchError:
            return False

    def create_mfa_ticket(
        self,
        *,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
    ) -> str:
        """Create a short-lived MFA challenge ticket JWT (5-min expiry)."""
        now = datetime.now(UTC)
        payload: dict[str, Any] = {
            "sub": str(user_id),
            "project_id": str(project_id),
            "type": "mfa_challenge",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=MFA_TICKET_EXPIRE_MINUTES)).timestamp()),
        }
        return _build_mldsa65_token(payload, self._private_key)

    def decode_mfa_ticket(self, ticket: str) -> dict[str, Any]:
        """Decode and validate an MFA challenge ticket.

        Raises InvalidTokenError, TokenExpiredError, or ValueError.
        """
        payload: dict[str, Any] = decode_token(ticket, self._public_key)
        if payload.get("type") != "mfa_challenge":
            raise ValueError("Invalid ticket type: expected mfa_challenge")
        return payload
