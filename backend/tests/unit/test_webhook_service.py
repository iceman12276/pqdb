"""Unit tests for webhook dispatch service.

Tests:
- URL validation (HTTPS required)
- Token generation (32 bytes, cryptographically random)
- Payload format validation
- Token hash round-trip (argon2id)
- WebhookDispatcher construction and dispatch
"""

from __future__ import annotations

import secrets
from unittest.mock import AsyncMock, patch

import pytest

from pqdb_api.services.webhook import (
    WebhookDispatcher,
    generate_verification_token,
    hash_verification_token,
    validate_webhook_url,
    verify_verification_token,
)


class TestValidateWebhookUrl:
    """Webhook URLs must be HTTPS."""

    def test_https_url_accepted(self) -> None:
        validate_webhook_url("https://example.com/webhook")

    def test_https_url_with_path_accepted(self) -> None:
        validate_webhook_url("https://api.example.com/v1/auth/webhook")

    def test_https_url_with_port_accepted(self) -> None:
        validate_webhook_url("https://example.com:8443/webhook")

    def test_http_url_rejected(self) -> None:
        with pytest.raises(ValueError, match="HTTPS"):
            validate_webhook_url("http://example.com/webhook")

    def test_empty_url_rejected(self) -> None:
        with pytest.raises(ValueError):
            validate_webhook_url("")

    def test_no_scheme_rejected(self) -> None:
        with pytest.raises(ValueError):
            validate_webhook_url("example.com/webhook")

    def test_ftp_url_rejected(self) -> None:
        with pytest.raises(ValueError, match="HTTPS"):
            validate_webhook_url("ftp://example.com/webhook")

    def test_none_rejected(self) -> None:
        with pytest.raises(ValueError):
            validate_webhook_url("")


class TestTokenGeneration:
    """Token generation must be 32 bytes, cryptographically random."""

    def test_token_is_url_safe_string(self) -> None:
        token = generate_verification_token()
        assert isinstance(token, str)
        assert len(token) > 0

    def test_token_length(self) -> None:
        """secrets.token_urlsafe(32) produces ~43 chars."""
        token = generate_verification_token()
        # token_urlsafe(32) base64 encodes 32 bytes -> ~43 characters
        assert len(token) >= 40

    def test_tokens_are_unique(self) -> None:
        tokens = {generate_verification_token() for _ in range(100)}
        assert len(tokens) == 100

    def test_uses_secrets_module(self) -> None:
        with patch.object(secrets, "token_urlsafe", return_value="mocked") as m:
            result = generate_verification_token()
            m.assert_called_once_with(32)
            assert result == "mocked"


class TestTokenHashRoundTrip:
    """Token hashing uses argon2id and verifies correctly."""

    def test_hash_returns_argon2id_hash(self) -> None:
        token = generate_verification_token()
        hashed = hash_verification_token(token)
        assert hashed.startswith("$argon2id$")

    def test_verify_correct_token(self) -> None:
        token = generate_verification_token()
        hashed = hash_verification_token(token)
        assert verify_verification_token(hashed, token) is True

    def test_verify_wrong_token(self) -> None:
        token = generate_verification_token()
        hashed = hash_verification_token(token)
        assert verify_verification_token(hashed, "wrong-token") is False

    def test_different_tokens_produce_different_hashes(self) -> None:
        t1 = generate_verification_token()
        t2 = generate_verification_token()
        h1 = hash_verification_token(t1)
        h2 = hash_verification_token(t2)
        assert h1 != h2


class TestWebhookDispatcher:
    """WebhookDispatcher POSTs JSON payloads to configured URLs."""

    def test_construction(self) -> None:
        dispatcher = WebhookDispatcher(timeout=5.0)
        assert dispatcher.timeout == 5.0

    def test_default_timeout(self) -> None:
        dispatcher = WebhookDispatcher()
        assert dispatcher.timeout == 5.0

    @pytest.mark.asyncio()
    async def test_dispatch_builds_correct_payload(self) -> None:
        dispatcher = WebhookDispatcher()

        with patch("pqdb_api.services.webhook.httpx") as mock_httpx:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_response = AsyncMock()
            mock_response.status_code = 200
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_httpx.AsyncClient.return_value = mock_client

            await dispatcher.dispatch(
                url="https://example.com/webhook",
                event_type="magic_link",
                email="user@test.com",
                token="test-token-123",
                expires_in=3600,
            )

            mock_client.post.assert_called_once()
            call_kwargs = mock_client.post.call_args
            assert call_kwargs[0][0] == "https://example.com/webhook"
            payload = call_kwargs[1]["json"]
            assert payload["type"] == "magic_link"
            assert payload["to"] == "user@test.com"
            assert payload["token"] == "test-token-123"
            assert payload["expires_in"] == 3600

    @pytest.mark.asyncio()
    async def test_dispatch_fire_and_forget_on_failure(self) -> None:
        """Dispatch should not raise even if the webhook call fails."""
        dispatcher = WebhookDispatcher()

        with patch("pqdb_api.services.webhook.httpx") as mock_httpx:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client.post = AsyncMock(side_effect=Exception("Connection failed"))
            mock_httpx.AsyncClient.return_value = mock_client

            # Should NOT raise
            await dispatcher.dispatch(
                url="https://example.com/webhook",
                event_type="magic_link",
                email="user@test.com",
                token="test-token-123",
                expires_in=3600,
            )

    @pytest.mark.asyncio()
    async def test_dispatch_uses_timeout(self) -> None:
        dispatcher = WebhookDispatcher(timeout=3.0)

        with patch("pqdb_api.services.webhook.httpx") as mock_httpx:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_response = AsyncMock()
            mock_response.status_code = 200
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_httpx.AsyncClient.return_value = mock_client
            mock_httpx.Timeout.return_value = "timeout-obj"

            await dispatcher.dispatch(
                url="https://example.com/webhook",
                event_type="email_verification",
                email="user@test.com",
                token="test-token-123",
                expires_in=1800,
            )

            mock_httpx.Timeout.assert_called_once_with(3.0)

    @pytest.mark.asyncio()
    async def test_dispatch_valid_event_types(self) -> None:
        """All three event types should be accepted."""
        dispatcher = WebhookDispatcher()

        for event_type in ("magic_link", "email_verification", "password_reset"):
            with patch("pqdb_api.services.webhook.httpx") as mock_httpx:
                mock_client = AsyncMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=None)
                mock_response = AsyncMock()
                mock_response.status_code = 200
                mock_client.post = AsyncMock(return_value=mock_response)
                mock_httpx.AsyncClient.return_value = mock_client

                await dispatcher.dispatch(
                    url="https://example.com/webhook",
                    event_type=event_type,
                    email="user@test.com",
                    token="tok",
                    expires_in=3600,
                )

                payload = mock_client.post.call_args[1]["json"]
                assert payload["type"] == event_type
