"""Unit tests for passkey/WebAuthn routes — US-053.

Tests challenge generation, model existence, credential CRUD,
and helper functions. Does not need Postgres (pure logic tests).
"""

from __future__ import annotations

import base64
import uuid

import pytest

from pqdb_api.models.developer import DeveloperCredential


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded)


class TestDeveloperCredentialModel:
    """Test DeveloperCredential model exists with correct fields."""

    def test_model_exists(self) -> None:
        cred = DeveloperCredential(
            id=uuid.uuid4(),
            developer_id=uuid.uuid4(),
            credential_id=b"\x01\x02\x03",
            public_key=b"\x04\x05\x06",
            sign_count=0,
            name="My Passkey",
        )
        assert cred.credential_id == b"\x01\x02\x03"
        assert cred.public_key == b"\x04\x05\x06"
        assert cred.sign_count == 0
        assert cred.name == "My Passkey"

    def test_model_allows_null_name(self) -> None:
        cred = DeveloperCredential(
            id=uuid.uuid4(),
            developer_id=uuid.uuid4(),
            credential_id=b"\x01",
            public_key=b"\x02",
        )
        assert cred.name is None

    def test_model_allows_null_last_used_at(self) -> None:
        cred = DeveloperCredential(
            id=uuid.uuid4(),
            developer_id=uuid.uuid4(),
            credential_id=b"\x01",
            public_key=b"\x02",
        )
        assert cred.last_used_at is None

    def test_model_tablename(self) -> None:
        assert DeveloperCredential.__tablename__ == "developer_credentials"


class TestBase64UrlHelpers:
    """Test base64url encode/decode helpers used in passkey routes."""

    def test_round_trip(self) -> None:
        from pqdb_api.routes.passkeys import _b64url_decode, _b64url_encode

        data = b"\x00\x01\x02\xff\xfe\xfd"
        encoded = _b64url_encode(data)
        assert _b64url_decode(encoded) == data

    def test_no_padding_in_encoded(self) -> None:
        from pqdb_api.routes.passkeys import _b64url_encode

        encoded = _b64url_encode(b"\x01\x02\x03")
        assert "=" not in encoded

    def test_url_safe_chars(self) -> None:
        from pqdb_api.routes.passkeys import _b64url_encode

        # Data that would produce + and / in standard base64
        data = bytes(range(256))
        encoded = _b64url_encode(data)
        assert "+" not in encoded
        assert "/" not in encoded


class TestWebAuthnConfig:
    """Test WebAuthn settings in config."""

    def test_default_rp_id(self) -> None:
        from pqdb_api.config import Settings

        settings = Settings(
            database_url="postgresql+asyncpg://x:x@localhost/test",
        )
        assert settings.webauthn_rp_id == "localhost"

    def test_default_rp_name(self) -> None:
        from pqdb_api.config import Settings

        settings = Settings(
            database_url="postgresql+asyncpg://x:x@localhost/test",
        )
        assert settings.webauthn_rp_name == "pqdb"

    def test_default_origin(self) -> None:
        from pqdb_api.config import Settings

        settings = Settings(
            database_url="postgresql+asyncpg://x:x@localhost/test",
        )
        assert settings.webauthn_origin == "http://localhost:3000"

    def test_custom_rp_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from pqdb_api.config import Settings

        monkeypatch.setenv("PQDB_WEBAUTHN_RP_ID", "pqdb.io")
        settings = Settings(
            database_url="postgresql+asyncpg://x:x@localhost/test",
        )
        assert settings.webauthn_rp_id == "pqdb.io"


class TestChallengeStore:
    """Test in-memory challenge store used for passkey flows."""

    def test_store_and_retrieve_challenge(self) -> None:
        from pqdb_api.routes.passkeys import _challenge_store

        # Clear store
        _challenge_store.clear()

        challenge_key = _b64url_encode(b"test-challenge")
        _challenge_store[challenge_key] = {
            "developer_id": str(uuid.uuid4()),
            "purpose": "registration",
        }

        assert challenge_key in _challenge_store
        retrieved = _challenge_store.pop(challenge_key)
        assert retrieved["purpose"] == "registration"
        assert challenge_key not in _challenge_store

    def test_pop_returns_none_for_missing(self) -> None:
        from pqdb_api.routes.passkeys import _challenge_store

        _challenge_store.clear()
        assert _challenge_store.pop("nonexistent", None) is None


class TestWebAuthnOptionsGeneration:
    """Test that webauthn library can generate options."""

    def test_generate_registration_options(self) -> None:
        import webauthn
        from webauthn.helpers.structs import (
            AuthenticatorSelectionCriteria,
            ResidentKeyRequirement,
            UserVerificationRequirement,
        )

        dev_id = uuid.uuid4()
        options = webauthn.generate_registration_options(
            rp_id="localhost",
            rp_name="pqdb",
            user_name="dev@test.com",
            user_id=dev_id.bytes,
            user_display_name="dev@test.com",
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.REQUIRED,
                user_verification=UserVerificationRequirement.PREFERRED,
            ),
        )
        assert options.rp.id == "localhost"
        assert options.rp.name == "pqdb"
        assert len(options.challenge) > 0
        assert options.user.name == "dev@test.com"

    def test_generate_authentication_options(self) -> None:
        import webauthn
        from webauthn.helpers.structs import UserVerificationRequirement

        options = webauthn.generate_authentication_options(
            rp_id="localhost",
            allow_credentials=[],
            user_verification=UserVerificationRequirement.PREFERRED,
        )
        assert options.rp_id == "localhost"
        assert len(options.challenge) > 0
        assert options.allow_credentials == []

    def test_options_to_json_produces_valid_json(self) -> None:
        import json

        import webauthn

        options = webauthn.generate_authentication_options(
            rp_id="localhost",
            allow_credentials=[],
        )
        json_str = webauthn.options_to_json(options)
        parsed = json.loads(json_str)
        assert "challenge" in parsed
        assert "rpId" in parsed
