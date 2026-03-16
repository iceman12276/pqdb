"""OAuth provider adapter interface and implementations.

Defines the abstract OAuthProvider base class and concrete implementations
for Google and GitHub OAuth providers.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from urllib.parse import urlencode


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
        raise NotImplementedError("Token exchange requires HTTP client")

    async def get_user_info(self, tokens: OAuthTokens) -> OAuthUserInfo:
        raise NotImplementedError("User info retrieval requires HTTP client")


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
        raise NotImplementedError("Token exchange requires HTTP client")

    async def get_user_info(self, tokens: OAuthTokens) -> OAuthUserInfo:
        raise NotImplementedError("User info retrieval requires HTTP client")
