"""Unit tests for ML-DSA-65 custom JWT token creation and verification.

Tests the custom JWT-like format:
  base64url(header).base64url(payload).base64url(signature)
where header = {"alg": "ML-DSA-65", "typ": "JWT"} and
signature is ML-DSA-65 over header.payload.
"""

import base64
import json
import time
import uuid
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

try:
    import oqs  # noqa: F401

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    HAS_OQS = False

from pqdb_api.services.auth import (
    MLDSA65_ALGORITHM,
    InvalidTokenError,
    TokenExpiredError,
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_mldsa65_keypair,
)

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)


@pytest.fixture()
def mldsa65_keys() -> tuple[bytes, bytes]:
    """Generate a fresh ML-DSA-65 keypair for each test."""
    return generate_mldsa65_keypair()


class TestMLDSA65TokenFormat:
    """Tests for the custom JWT-like token format."""

    def test_token_has_three_dot_separated_parts(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, _ = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        parts = token.split(".")
        assert len(parts) == 3

    def test_header_contains_mldsa65_algorithm(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, _ = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        header_b64 = token.split(".")[0]
        # Add padding for base64url
        padded = header_b64 + "=" * (-len(header_b64) % 4)
        header_json = base64.urlsafe_b64decode(padded)
        header = json.loads(header_json)
        assert header["alg"] == MLDSA65_ALGORITHM
        assert header["typ"] == "JWT"

    def test_payload_contains_expected_claims(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, _ = mldsa65_keys
        dev_id = uuid.uuid4()
        token = create_access_token(dev_id, private_key)
        payload_b64 = token.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload_json = base64.urlsafe_b64decode(padded)
        payload = json.loads(payload_json)
        assert payload["sub"] == str(dev_id)
        assert payload["type"] == "access"
        assert "iat" in payload
        assert "exp" in payload

    def test_token_is_approximately_4600_chars(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        """ML-DSA-65 signatures are ~3309 bytes, base64url ~4412 chars.
        Total token should be roughly 4600 chars."""
        private_key, _ = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        # Allow some variance, but it should be in the 4000-5500 range
        assert 4000 <= len(token) <= 5500, (
            f"Token length {len(token)} outside expected range"
        )


class TestMLDSA65AccessToken:
    """Tests for access token creation with ML-DSA-65."""

    def test_create_access_token_returns_string(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, _ = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        assert isinstance(token, str)
        assert len(token) > 0

    def test_access_token_roundtrip(self, mldsa65_keys: tuple[bytes, bytes]) -> None:
        private_key, public_key = mldsa65_keys
        dev_id = uuid.uuid4()
        token = create_access_token(dev_id, private_key)
        payload = decode_token(token, public_key)
        assert payload["sub"] == str(dev_id)
        assert payload["type"] == "access"

    def test_access_token_expires_in_15_minutes(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        payload = decode_token(token, public_key)
        exp = payload["exp"]
        iat = payload["iat"]
        assert exp - iat == 15 * 60  # 15 minutes in seconds


class TestMLDSA65RefreshToken:
    """Tests for refresh token creation with ML-DSA-65."""

    def test_create_refresh_token_returns_string(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, _ = mldsa65_keys
        token = create_refresh_token(uuid.uuid4(), private_key)
        assert isinstance(token, str)
        assert len(token) > 0

    def test_refresh_token_roundtrip(self, mldsa65_keys: tuple[bytes, bytes]) -> None:
        private_key, public_key = mldsa65_keys
        dev_id = uuid.uuid4()
        token = create_refresh_token(dev_id, private_key)
        payload = decode_token(token, public_key)
        assert payload["sub"] == str(dev_id)
        assert payload["type"] == "refresh"

    def test_refresh_token_expires_in_7_days(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        token = create_refresh_token(uuid.uuid4(), private_key)
        payload = decode_token(token, public_key)
        exp = payload["exp"]
        iat = payload["iat"]
        assert exp - iat == 7 * 24 * 60 * 60  # 7 days in seconds


class TestMLDSA65TokenVerification:
    """Tests for ML-DSA-65 token verification edge cases."""

    def test_decode_with_wrong_key_raises(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, _ = mldsa65_keys
        _, other_public = generate_mldsa65_keypair()
        token = create_access_token(uuid.uuid4(), private_key)
        with pytest.raises(InvalidTokenError, match="[Ss]ignature"):
            decode_token(token, other_public)

    def test_decode_expired_token_raises(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        with patch("pqdb_api.services.auth.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2020, 1, 1, tzinfo=UTC)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            token = create_access_token(uuid.uuid4(), private_key)
        with pytest.raises(TokenExpiredError):
            decode_token(token, public_key)

    def test_decode_tampered_signature_raises(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        # Tamper with the signature part
        parts = token.split(".")
        tampered_sig = parts[2][:-5] + "XXXXX"
        tampered_token = f"{parts[0]}.{parts[1]}.{tampered_sig}"
        with pytest.raises(InvalidTokenError, match="[Ss]ignature"):
            decode_token(tampered_token, public_key)

    def test_decode_tampered_payload_raises(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        parts = token.split(".")
        # Decode, modify, re-encode payload
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        payload["sub"] = str(uuid.uuid4())  # Change the subject
        new_payload_b64 = (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )
        tampered_token = f"{parts[0]}.{new_payload_b64}.{parts[2]}"
        with pytest.raises(InvalidTokenError, match="[Ss]ignature"):
            decode_token(tampered_token, public_key)

    def test_decode_wrong_algorithm_header_raises(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        private_key, public_key = mldsa65_keys
        token = create_access_token(uuid.uuid4(), private_key)
        parts = token.split(".")
        # Replace header with EdDSA algorithm
        bad_header = (
            base64.urlsafe_b64encode(
                json.dumps({"alg": "EdDSA", "typ": "JWT"}).encode()
            )
            .rstrip(b"=")
            .decode()
        )
        tampered_token = f"{bad_header}.{parts[1]}.{parts[2]}"
        with pytest.raises(InvalidTokenError, match="[Aa]lgorithm"):
            decode_token(tampered_token, public_key)

    def test_decode_malformed_token_raises(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        _, public_key = mldsa65_keys
        with pytest.raises(InvalidTokenError):
            decode_token("not.a.valid.token.format", public_key)
        with pytest.raises(InvalidTokenError):
            decode_token("onlytwoparts.here", public_key)
        with pytest.raises(InvalidTokenError):
            decode_token("", public_key)

    def test_decode_validates_exp_claim(
        self, mldsa65_keys: tuple[bytes, bytes]
    ) -> None:
        """Token without exp claim should raise."""
        private_key, public_key = mldsa65_keys
        # Manually create a token without exp
        import oqs

        header = {"alg": MLDSA65_ALGORITHM, "typ": "JWT"}
        payload = {"sub": str(uuid.uuid4()), "type": "access", "iat": int(time.time())}
        header_b64 = (
            base64.urlsafe_b64encode(json.dumps(header).encode()).rstrip(b"=").decode()
        )
        payload_b64 = (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )
        message = f"{header_b64}.{payload_b64}".encode()
        signer = oqs.Signature(MLDSA65_ALGORITHM, private_key)
        signature = signer.sign(message)
        sig_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
        token = f"{header_b64}.{payload_b64}.{sig_b64}"
        with pytest.raises(InvalidTokenError, match="exp"):
            decode_token(token, public_key)
