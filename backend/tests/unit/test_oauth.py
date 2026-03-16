"""Unit tests for OAuth provider adapter interface and dataclasses."""


import pytest

from pqdb_api.services.oauth import (
    GoogleOAuthProvider,
    OAuthProvider,
    OAuthTokens,
    OAuthUserInfo,
)


class TestOAuthDataclasses:
    """Tests for OAuthTokens and OAuthUserInfo dataclasses."""

    def test_oauth_tokens_fields(self) -> None:
        tokens = OAuthTokens(
            access_token="access123",
            refresh_token="refresh456",
            expires_in=3600,
            token_type="Bearer",
        )
        assert tokens.access_token == "access123"
        assert tokens.refresh_token == "refresh456"
        assert tokens.expires_in == 3600
        assert tokens.token_type == "Bearer"

    def test_oauth_tokens_optional_refresh(self) -> None:
        tokens = OAuthTokens(
            access_token="access123",
            refresh_token=None,
            expires_in=3600,
            token_type="Bearer",
        )
        assert tokens.refresh_token is None

    def test_oauth_user_info_fields(self) -> None:
        info = OAuthUserInfo(
            email="user@example.com",
            name="Test User",
            avatar_url="https://example.com/avatar.png",
            provider_uid="12345",
        )
        assert info.email == "user@example.com"
        assert info.name == "Test User"
        assert info.avatar_url == "https://example.com/avatar.png"
        assert info.provider_uid == "12345"

    def test_oauth_user_info_optional_fields(self) -> None:
        info = OAuthUserInfo(
            email="user@example.com",
            name=None,
            avatar_url=None,
            provider_uid="12345",
        )
        assert info.name is None
        assert info.avatar_url is None


class TestOAuthProviderABC:
    """Tests for OAuthProvider abstract base class."""

    def test_cannot_instantiate_directly(self) -> None:
        with pytest.raises(TypeError):
            OAuthProvider()  # type: ignore[abstract]

    def test_subclass_must_implement_all_methods(self) -> None:
        class IncompleteProvider(OAuthProvider):
            pass

        with pytest.raises(TypeError):
            IncompleteProvider()  # type: ignore[abstract]

    def test_concrete_subclass_can_be_instantiated(self) -> None:
        class ConcreteProvider(OAuthProvider):
            def get_authorization_url(self, state: str, redirect_uri: str) -> str:
                return "https://example.com/auth"

            async def exchange_code(self, code: str, redirect_uri: str) -> OAuthTokens:
                return OAuthTokens(
                    access_token="test",
                    refresh_token=None,
                    expires_in=3600,
                    token_type="Bearer",
                )

            async def get_user_info(self, tokens: OAuthTokens) -> OAuthUserInfo:
                return OAuthUserInfo(
                    email="test@test.com",
                    name="Test",
                    avatar_url=None,
                    provider_uid="123",
                )

        provider = ConcreteProvider()
        assert isinstance(provider, OAuthProvider)


class TestGoogleOAuthProvider:
    """Tests for Google OAuth provider implementation."""

    def test_get_authorization_url(self) -> None:
        provider = GoogleOAuthProvider(
            client_id="google-client-id",
            client_secret="google-client-secret",
        )
        url = provider.get_authorization_url(
            state="random-state",
            redirect_uri="https://myapp.com/callback",
        )
        assert "accounts.google.com" in url
        assert "google-client-id" in url
        assert "random-state" in url
        assert "https%3A%2F%2Fmyapp.com%2Fcallback" in url
        assert "openid" in url
        assert "email" in url
        assert "profile" in url
