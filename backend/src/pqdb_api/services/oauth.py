"""OAuth provider adapter interface and implementations.

Defines the abstract OAuthProvider base class and concrete implementations
for Google and GitHub OAuth providers.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import structlog

logger = structlog.get_logger()


@dataclass(frozen=True)
class OAuthTokens:
    """Tokens returned from an OAuth code exchange."""

    access_token: str
    refresh_token: str | None
    expires_in: int
    token_type: str


@dataclass(frozen=True)
class OAuthUserInfo:
    """User information retrieved from an OAuth provider."""

    email: str
    name: str | None
    avatar_url: str | None
    provider_uid: str


class OAuthProvider(abc.ABC):
    """Abstract base class for OAuth provider adapters."""

    @abc.abstractmethod
    def get_authorization_url(self, state: str, redirect_uri: str) -> str:
        """Build the authorization URL to redirect the user to."""

    @abc.abstractmethod
    async def exchange_code(self, code: str, redirect_uri: str) -> OAuthTokens:
        """Exchange an authorization code for tokens."""

    @abc.abstractmethod
    async def get_user_info(self, tokens: OAuthTokens) -> OAuthUserInfo:
        """Retrieve user info from the provider using the access token."""


class GoogleOAuthProvider(OAuthProvider):
    """Google OAuth 2.0 provider."""

    AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    TOKEN_URL = "https://oauth2.googleapis.com/token"
    USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

    def __init__(self, client_id: str, client_secret: str) -> None:
        self._client_id = client_id
        self._client_secret = client_secret

    def get_authorization_url(self, state: str, redirect_uri: str) -> str:
        params = urlencode(
            {
                "client_id": self._client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "openid email profile",
                "state": state,
                "access_type": "offline",
                "prompt": "consent",
            }
        )
        return f"{self.AUTHORIZE_URL}?{params}"

    async def exchange_code(self, code: str, redirect_uri: str) -> OAuthTokens:
        """Exchange authorization code for tokens via Google's token endpoint."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                self.TOKEN_URL,
                data={
                    "code": code,
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
            )

        if resp.status_code != 200:
            logger.error(
                "google_token_exchange_failed",
                status=resp.status_code,
                body=resp.text,
            )
            raise ValueError("Google token exchange failed")

        data = resp.json()
        return OAuthTokens(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token"),
            expires_in=data.get("expires_in", 3600),
            token_type=data.get("token_type", "Bearer"),
        )

    async def get_user_info(self, tokens: OAuthTokens) -> OAuthUserInfo:
        """Fetch user info from Google's userinfo endpoint."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                self.USERINFO_URL,
                headers={"Authorization": f"Bearer {tokens.access_token}"},
            )

        if resp.status_code != 200:
            logger.error(
                "google_userinfo_failed",
                status=resp.status_code,
                body=resp.text,
            )
            raise ValueError("Google user info retrieval failed")

        data = resp.json()
        return OAuthUserInfo(
            email=data["email"],
            name=data.get("name"),
            avatar_url=data.get("picture"),
            provider_uid=str(data["id"]),
        )


class GitHubOAuthProvider(OAuthProvider):
    """GitHub OAuth 2.0 provider."""

    AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
    TOKEN_URL = "https://github.com/login/oauth/access_token"
    USERINFO_URL = "https://api.github.com/user"

    def __init__(self, client_id: str, client_secret: str) -> None:
        self._client_id = client_id
        self._client_secret = client_secret

    def get_authorization_url(self, state: str, redirect_uri: str) -> str:
        params = urlencode(
            {
                "client_id": self._client_id,
                "redirect_uri": redirect_uri,
                "state": state,
                "scope": "user:email",
            }
        )
        return f"{self.AUTHORIZE_URL}?{params}"

    async def exchange_code(self, code: str, redirect_uri: str) -> OAuthTokens:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                self.TOKEN_URL,
                json={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()

        if "error" in data:
            raise ValueError(f"GitHub token exchange failed: {data['error']}")

        return OAuthTokens(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token"),
            expires_in=data.get("expires_in", 0),
            token_type=data.get("token_type", "bearer"),
        )

    async def get_user_info(self, tokens: OAuthTokens) -> OAuthUserInfo:
        headers = {
            "Authorization": f"Bearer {tokens.access_token}",
            "Accept": "application/json",
        }
        async with httpx.AsyncClient() as client:
            # Fetch user profile
            user_resp = await client.get(self.USERINFO_URL, headers=headers)
            user_resp.raise_for_status()
            user_data: dict[str, Any] = user_resp.json()

            # Fetch emails to find verified primary email
            emails_resp = await client.get(
                "https://api.github.com/user/emails", headers=headers
            )
            emails_resp.raise_for_status()
            emails: list[dict[str, Any]] = emails_resp.json()

        # Find verified primary email
        email: str | None = None
        for entry in emails:
            if entry.get("primary") and entry.get("verified"):
                email = entry["email"]
                break

        if email is None:
            raise ValueError("No verified primary email found on GitHub account")

        return OAuthUserInfo(
            email=email,
            name=user_data.get("name"),
            avatar_url=user_data.get("avatar_url"),
            provider_uid=str(user_data["id"]),
        )
