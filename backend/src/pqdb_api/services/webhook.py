"""Webhook dispatch service for auth events.

Sends JSON payloads to configured webhook URLs for auth events
(magic links, email verification, password reset). Fire-and-forget
with a configurable timeout — auth operations never fail due to
webhook delivery failures.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlparse

import httpx
import structlog
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

logger = structlog.get_logger()

_hasher = PasswordHasher()


def validate_webhook_url(url: str) -> None:
    """Validate that a webhook URL uses HTTPS.

    Raises ValueError if the URL is empty, malformed, or not HTTPS.
    """
    if not url:
        raise ValueError("Webhook URL must not be empty")

    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(
            f"Webhook URL must use HTTPS, got {parsed.scheme or 'no scheme'}://"
        )
    if not parsed.netloc:
        raise ValueError("Webhook URL must include a host")


def generate_verification_token() -> str:
    """Generate a 32-byte cryptographically random URL-safe token."""
    return secrets.token_urlsafe(32)


def hash_verification_token(token: str) -> str:
    """Hash a verification token using argon2id for storage."""
    return _hasher.hash(token)


def verify_verification_token(token_hash: str, token: str) -> bool:
    """Verify a verification token against its stored argon2id hash."""
    try:
        return _hasher.verify(token_hash, token)
    except VerifyMismatchError:
        return False


class WebhookDispatcher:
    """Dispatches auth event webhooks to configured URLs.

    Fire-and-forget: logs success/failure but never raises exceptions
    from dispatch(). Timeout defaults to 5 seconds.
    """

    def __init__(self, timeout: float = 5.0) -> None:
        self.timeout = timeout

    async def dispatch(
        self,
        *,
        url: str,
        event_type: str,
        email: str,
        token: str,
        expires_in: int,
    ) -> None:
        """POST a JSON payload to the webhook URL.

        Payload format:
        {
            "type": "magic_link" | "email_verification" | "password_reset",
            "to": "<email>",
            "token": "<plaintext_token>",
            "expires_in": <seconds>
        }

        Fire-and-forget: logs success or failure, never raises.
        """
        payload = {
            "type": event_type,
            "to": email,
            "token": token,
            "expires_in": expires_in,
        }

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout),
            ) as client:
                response = await client.post(url, json=payload)

            logger.info(
                "webhook_dispatched",
                url=url,
                event_type=event_type,
                email=email,
                status_code=response.status_code,
            )
        except Exception as exc:
            logger.error(
                "webhook_dispatch_failed",
                url=url,
                event_type=event_type,
                email=email,
                error=str(exc),
            )
