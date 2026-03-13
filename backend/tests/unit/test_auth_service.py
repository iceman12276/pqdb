"""Unit tests for the auth service: password hashing and JWT operations."""

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import jwt
import pytest

from pqdb_api.services.auth import (
    JWT_ALGORITHM,
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_ed25519_keypair,
    hash_password,
    private_key_to_pem,
    public_key_to_pem,
    verify_password,
)


class TestPasswordHashing:
    """Tests for argon2id password hashing."""

    def test_hash_password_returns_string(self) -> None:
        result = hash_password("mysecretpassword")
        assert isinstance(result, str)

    def test_hash_password_contains_argon2id_marker(self) -> None:
        result = hash_password("mysecretpassword")
        assert "$argon2id$" in result

    def test_verify_password_correct(self) -> None:
        pw = "correcthorsebatterystaple"
        hashed = hash_password(pw)
        assert verify_password(hashed, pw) is True

    def test_verify_password_incorrect(self) -> None:
        hashed = hash_password("correctpassword")
        assert verify_password(hashed, "wrongpassword") is False

    def test_hash_is_unique_per_call(self) -> None:
        h1 = hash_password("same")
        h2 = hash_password("same")
        assert h1 != h2


class TestEd25519KeyPair:
    """Tests for Ed25519 key generation and serialization."""

    def test_generate_keypair(self) -> None:
        private_key, public_key = generate_ed25519_keypair()
        assert private_key is not None
        assert public_key is not None

    def test_private_key_to_pem(self) -> None:
        private_key, _ = generate_ed25519_keypair()
        pem = private_key_to_pem(private_key)
        assert pem.startswith(b"-----BEGIN PRIVATE KEY-----")

    def test_public_key_to_pem(self) -> None:
        _, public_key = generate_ed25519_keypair()
        pem = public_key_to_pem(public_key)
        assert pem.startswith(b"-----BEGIN PUBLIC KEY-----")


class TestJWTTokens:
    """Tests for JWT token creation and validation."""

    def setup_method(self) -> None:
        self.private_key, self.public_key = generate_ed25519_keypair()
        self.developer_id = uuid.uuid4()

    def test_create_access_token_is_string(self) -> None:
        token = create_access_token(self.developer_id, self.private_key)
        assert isinstance(token, str)
        assert len(token) > 0

    def test_access_token_contains_correct_claims(self) -> None:
        token = create_access_token(self.developer_id, self.private_key)
        payload = decode_token(token, self.public_key)
        assert payload["sub"] == str(self.developer_id)
        assert payload["type"] == "access"
        assert "iat" in payload
        assert "exp" in payload

    def test_access_token_expires_in_15_minutes(self) -> None:
        token = create_access_token(self.developer_id, self.private_key)
        payload = decode_token(token, self.public_key)
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        iat = datetime.fromtimestamp(payload["iat"], tz=UTC)
        delta = exp - iat
        assert delta == timedelta(minutes=15)

    def test_create_refresh_token_is_string(self) -> None:
        token = create_refresh_token(self.developer_id, self.private_key)
        assert isinstance(token, str)
        assert len(token) > 0

    def test_refresh_token_contains_correct_claims(self) -> None:
        token = create_refresh_token(self.developer_id, self.private_key)
        payload = decode_token(token, self.public_key)
        assert payload["sub"] == str(self.developer_id)
        assert payload["type"] == "refresh"

    def test_refresh_token_expires_in_7_days(self) -> None:
        token = create_refresh_token(self.developer_id, self.private_key)
        payload = decode_token(token, self.public_key)
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        iat = datetime.fromtimestamp(payload["iat"], tz=UTC)
        delta = exp - iat
        assert delta == timedelta(days=7)

    def test_decode_token_with_wrong_key_raises(self) -> None:
        token = create_access_token(self.developer_id, self.private_key)
        _, other_public = generate_ed25519_keypair()
        with pytest.raises(jwt.PyJWTError):
            decode_token(token, other_public)

    def test_decode_expired_token_raises(self) -> None:
        with patch("pqdb_api.services.auth.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2020, 1, 1, tzinfo=UTC)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            token = create_access_token(self.developer_id, self.private_key)
        with pytest.raises(jwt.ExpiredSignatureError):
            decode_token(token, self.public_key)

    def test_decode_tampered_token_raises(self) -> None:
        token = create_access_token(self.developer_id, self.private_key)
        tampered = token[:-5] + "XXXXX"
        with pytest.raises(jwt.PyJWTError):
            decode_token(tampered, self.public_key)

    def test_algorithm_is_eddsa(self) -> None:
        assert JWT_ALGORITHM == "EdDSA"
