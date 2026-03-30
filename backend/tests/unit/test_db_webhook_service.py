"""Unit tests for database webhook service (US-110).

Tests:
- Payload construction for INSERT/UPDATE/DELETE events
- HMAC-SHA256 signing of payloads
- Retry logic with exponential backoff
- Webhook table SQL generation
- Trigger SQL generation
- URL validation (SSRF prevention)
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pqdb_api.routes.webhooks import validate_webhook_url
from pqdb_api.services.db_webhook import (
    build_webhook_payload,
    compute_hmac_signature,
    deliver_webhook,
)

_PATCH_CLIENT = "pqdb_api.services.db_webhook.httpx.AsyncClient"
_PATCH_SLEEP = "pqdb_api.services.db_webhook.asyncio.sleep"

_SAMPLE_PAYLOAD: dict[str, object] = {
    "table": "t",
    "event": "INSERT",
    "row": {},
    "timestamp": "2026-01-01T00:00:00Z",
}


def _mock_async_client(
    post_side_effect: object = None,
    post_return: object = None,
) -> AsyncMock:
    """Build a mock httpx.AsyncClient context manager."""
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    if post_side_effect is not None:
        client.post = AsyncMock(side_effect=post_side_effect)
    elif post_return is not None:
        client.post = AsyncMock(return_value=post_return)
    return client


def _mock_response(status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    return resp


class TestBuildWebhookPayload:
    """Payload must contain table, event, row, and timestamp."""

    def test_insert_event_payload(self) -> None:
        payload = build_webhook_payload(
            table_name="users",
            event="INSERT",
            row_data={"id": 1, "name": "Alice"},
        )
        assert payload["table"] == "users"
        assert payload["event"] == "INSERT"
        assert payload["row"] == {"id": 1, "name": "Alice"}
        assert "timestamp" in payload

    def test_update_event_payload(self) -> None:
        payload = build_webhook_payload(
            table_name="orders",
            event="UPDATE",
            row_data={"id": 5, "status": "shipped"},
        )
        assert payload["table"] == "orders"
        assert payload["event"] == "UPDATE"
        assert payload["row"] == {"id": 5, "status": "shipped"}

    def test_delete_event_payload(self) -> None:
        payload = build_webhook_payload(
            table_name="sessions",
            event="DELETE",
            row_data={"id": 99},
        )
        assert payload["table"] == "sessions"
        assert payload["event"] == "DELETE"
        assert payload["row"] == {"id": 99}

    def test_timestamp_is_iso_format(self) -> None:
        payload = build_webhook_payload(
            table_name="t",
            event="INSERT",
            row_data={},
        )
        from datetime import datetime, timezone

        ts = payload["timestamp"]
        assert isinstance(ts, str)
        dt = datetime.fromisoformat(ts)
        assert dt.tzinfo is not None or dt.tzinfo == timezone.utc

    def test_empty_row_data(self) -> None:
        payload = build_webhook_payload(
            table_name="t",
            event="INSERT",
            row_data={},
        )
        assert payload["row"] == {}


class TestComputeHmacSignature:
    """HMAC-SHA256 signing with webhook secret."""

    def test_signature_is_hex_string(self) -> None:
        sig = compute_hmac_signature(
            secret="my-secret",
            payload_json='{"table":"t","event":"INSERT","row":{}}',
        )
        assert isinstance(sig, str)
        # SHA256 hex digest is 64 chars
        assert len(sig) == 64

    def test_signature_matches_manual_hmac(self) -> None:
        secret = "test-webhook-secret"
        body = '{"table":"users","event":"INSERT","row":{"id":1}}'
        expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        result = compute_hmac_signature(secret=secret, payload_json=body)
        assert result == expected

    def test_different_secrets_different_sigs(self) -> None:
        body = '{"table":"t","event":"INSERT","row":{}}'
        sig1 = compute_hmac_signature(secret="secret-1", payload_json=body)
        sig2 = compute_hmac_signature(secret="secret-2", payload_json=body)
        assert sig1 != sig2

    def test_different_payloads_different_sigs(self) -> None:
        secret = "same-secret"
        sig1 = compute_hmac_signature(secret=secret, payload_json='{"event":"INSERT"}')
        sig2 = compute_hmac_signature(secret=secret, payload_json='{"event":"DELETE"}')
        assert sig1 != sig2


class TestDeliverWebhook:
    """deliver_webhook POSTs with HMAC signature and retries."""

    @pytest.mark.asyncio()
    async def test_successful_delivery(self) -> None:
        client = _mock_async_client(post_return=_mock_response(200))

        with patch(_PATCH_CLIENT, return_value=client):
            result = await deliver_webhook(
                url="https://example.com/hook",
                payload=_SAMPLE_PAYLOAD,
                secret="my-secret",
            )

        assert result is True
        client.post.assert_called_once()
        call_kw = client.post.call_args
        assert call_kw[0][0] == "https://example.com/hook"
        assert "X-Webhook-Signature" in call_kw[1]["headers"]

    @pytest.mark.asyncio()
    async def test_sends_hmac_in_header(self) -> None:
        payload: dict[str, object] = {
            "table": "t",
            "event": "INSERT",
            "row": {"id": 1},
            "timestamp": "2026-01-01T00:00:00Z",
        }
        client = _mock_async_client(post_return=_mock_response(200))

        with patch(_PATCH_CLIENT, return_value=client):
            await deliver_webhook(
                url="https://example.com/hook",
                payload=payload,
                secret="test-secret",
            )

        call_kw = client.post.call_args
        body_json = call_kw[1]["content"]
        expected_sig = compute_hmac_signature(
            secret="test-secret", payload_json=body_json
        )
        header_sig = call_kw[1]["headers"]["X-Webhook-Signature"]
        assert header_sig == expected_sig

    @pytest.mark.asyncio()
    async def test_retries_on_failure(self) -> None:
        """Retry up to 3 times with exponential backoff."""
        fail = _mock_response(500)
        ok = _mock_response(200)
        client = _mock_async_client(post_side_effect=[fail, fail, ok])

        with (
            patch(_PATCH_CLIENT, return_value=client),
            patch(_PATCH_SLEEP, new_callable=AsyncMock) as mock_sleep,
        ):
            result = await deliver_webhook(
                url="https://example.com/hook",
                payload=_SAMPLE_PAYLOAD,
                secret="s",
            )

        assert result is True
        assert client.post.call_count == 3
        assert mock_sleep.call_count == 2
        mock_sleep.assert_any_call(1)
        mock_sleep.assert_any_call(5)

    @pytest.mark.asyncio()
    async def test_false_after_all_retries_exhausted(self) -> None:
        client = _mock_async_client(post_return=_mock_response(500))

        with (
            patch(_PATCH_CLIENT, return_value=client),
            patch(_PATCH_SLEEP, new_callable=AsyncMock),
        ):
            result = await deliver_webhook(
                url="https://example.com/hook",
                payload=_SAMPLE_PAYLOAD,
                secret="s",
            )

        assert result is False
        assert client.post.call_count == 3

    @pytest.mark.asyncio()
    async def test_retries_on_connection_error(self) -> None:
        ok = _mock_response(200)
        client = _mock_async_client(
            post_side_effect=[
                Exception("Connection refused"),
                ok,
            ]
        )

        with (
            patch(_PATCH_CLIENT, return_value=client),
            patch(_PATCH_SLEEP, new_callable=AsyncMock),
        ):
            result = await deliver_webhook(
                url="https://example.com/hook",
                payload=_SAMPLE_PAYLOAD,
                secret="s",
            )

        assert result is True
        assert client.post.call_count == 2

    @pytest.mark.asyncio()
    async def test_payload_sent_as_json_string(self) -> None:
        """Body is a JSON string (not dict) for HMAC consistency."""
        client = _mock_async_client(post_return=_mock_response(200))
        payload: dict[str, object] = {
            "table": "t",
            "event": "INSERT",
            "row": {"id": 1},
            "timestamp": "now",
        }

        with patch(_PATCH_CLIENT, return_value=client):
            await deliver_webhook(
                url="https://example.com/hook",
                payload=payload,
                secret="s",
            )

        call_kw = client.post.call_args
        assert isinstance(call_kw[1]["content"], str)
        parsed = json.loads(call_kw[1]["content"])
        assert parsed == payload


class TestValidateWebhookUrl:
    """SSRF prevention: block internal IPs and enforce HTTPS."""

    def test_https_url_accepted(self) -> None:
        result = validate_webhook_url("https://example.com/hook")
        assert result == "https://example.com/hook"

    def test_http_rejected_in_production(self) -> None:
        with patch.dict("os.environ", {"PQDB_DEBUG": ""}, clear=False):
            with pytest.raises(ValueError, match="HTTPS"):
                validate_webhook_url("http://example.com/hook")

    def test_http_localhost_allowed_in_dev(self) -> None:
        with patch.dict("os.environ", {"PQDB_DEBUG": "true"}, clear=False):
            result = validate_webhook_url("http://localhost:8080/hook")
            assert result == "http://localhost:8080/hook"

    def test_http_non_localhost_rejected_in_dev(self) -> None:
        with patch.dict("os.environ", {"PQDB_DEBUG": "true"}, clear=False):
            with pytest.raises(ValueError, match="localhost"):
                validate_webhook_url("http://example.com/hook")

    def test_blocks_rfc1918_10_x(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://10.0.0.1/hook")

    def test_blocks_rfc1918_172_16(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://172.16.0.1/hook")

    def test_blocks_rfc1918_192_168(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://192.168.1.1/hook")

    def test_blocks_loopback(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://127.0.0.1/hook")

    def test_blocks_link_local(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://169.254.1.1/hook")

    def test_blocks_zero_network(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://0.0.0.0/hook")

    def test_blocks_ipv6_loopback(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://[::1]/hook")

    def test_blocks_ipv6_ula(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://[fd00::1]/hook")

    def test_blocks_ipv6_link_local(self) -> None:
        with pytest.raises(ValueError, match="internal"):
            validate_webhook_url("https://[fe80::1]/hook")

    def test_ftp_scheme_rejected(self) -> None:
        with pytest.raises(ValueError, match="HTTPS"):
            validate_webhook_url("ftp://example.com/hook")

    def test_no_hostname_rejected(self) -> None:
        with pytest.raises(ValueError, match="hostname"):
            validate_webhook_url("https:///path")

    def test_hostname_not_ip_accepted(self) -> None:
        result = validate_webhook_url("https://webhook.example.com/api/v1")
        assert "webhook.example.com" in result

    def test_public_ip_accepted(self) -> None:
        result = validate_webhook_url("https://203.0.113.50/hook")
        assert result == "https://203.0.113.50/hook"


class TestWebhookListenLoop:
    """Verify the webhook listener connects and handles cancellation."""

    @pytest.mark.asyncio()
    async def test_listen_loop_cancellation(self) -> None:
        """Listener should handle CancelledError gracefully."""
        from pqdb_api.services.db_webhook import webhook_listen_loop

        mock_conn = AsyncMock()
        mock_conn.add_listener = AsyncMock()
        mock_conn.close = AsyncMock()

        with patch(
            "pqdb_api.services.db_webhook.asyncpg.connect",
            new_callable=AsyncMock,
            return_value=mock_conn,
        ):
            mock_session_factory = AsyncMock()
            task = asyncio.create_task(
                webhook_listen_loop("postgresql://test/test", mock_session_factory)
            )
            # Let the task start and connect
            await asyncio.sleep(0.1)

            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

            # Verify it connected and set up listener
            mock_conn.add_listener.assert_called_once()

    @pytest.mark.asyncio()
    async def test_listen_loop_reconnects_on_error(self) -> None:
        """Listener should reconnect after a connection failure."""
        from pqdb_api.services.db_webhook import webhook_listen_loop

        mock_conn = AsyncMock()
        mock_conn.add_listener = AsyncMock()
        mock_conn.close = AsyncMock()

        # Track reconnect sleep calls separately from the test's own sleep
        real_sleep = asyncio.sleep
        reconnect_sleep_calls: list[float] = []

        async def _patched_sleep(delay: float) -> None:
            reconnect_sleep_calls.append(delay)

        with (
            patch(
                "pqdb_api.services.db_webhook.asyncpg.connect",
                new_callable=AsyncMock,
                side_effect=[
                    ConnectionError("Connection refused"),
                    mock_conn,
                ],
            ) as patched_connect,
            patch(
                "pqdb_api.services.db_webhook.asyncio.sleep",
                side_effect=_patched_sleep,
            ),
        ):
            mock_session_factory = AsyncMock()
            task = asyncio.create_task(
                webhook_listen_loop("postgresql://test/test", mock_session_factory)
            )
            # Use real sleep to let the task run
            await real_sleep(0.2)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            assert patched_connect.call_count >= 2
            assert 5 in reconnect_sleep_calls
