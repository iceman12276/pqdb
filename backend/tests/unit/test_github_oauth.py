"""Unit tests for GitHub OAuth provider adapter."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from pqdb_api.services.oauth import (
    GitHubOAuthProvider,
    OAuthTokens,
    OAuthUserInfo,
)


class TestGitHubOAuthProviderAuthorizationUrl:
    """Tests for GitHubOAuthProvider.get_authorization_url."""

    def test_generates_correct_url(self) -> None:
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        url = provider.get_authorization_url(
            state="random-state",
            redirect_uri="https://myapp.com/callback",
        )
        assert "github.com/login/oauth/authorize" in url
        assert "gh-client-id" in url
        assert "random-state" in url
        assert "https%3A%2F%2Fmyapp.com%2Fcallback" in url
        assert "user%3Aemail" in url

    def test_includes_scope_user_email(self) -> None:
        provider = GitHubOAuthProvider(client_id="test-id", client_secret="test-secret")
        url = provider.get_authorization_url(state="s", redirect_uri="https://x.com/cb")
        assert "scope=user%3Aemail" in url


class TestGitHubOAuthProviderExchangeCode:
    """Tests for GitHubOAuthProvider.exchange_code."""

    @pytest.mark.asyncio
    async def test_exchange_code_success(self) -> None:
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "access_token": "gho_test_token",
            "token_type": "bearer",
            "scope": "user:email",
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "pqdb_api.services.oauth.httpx.AsyncClient", return_value=mock_client
        ):
            tokens = await provider.exchange_code(
                code="auth-code-123",
                redirect_uri="https://myapp.com/callback",
            )

        assert isinstance(tokens, OAuthTokens)
        assert tokens.access_token == "gho_test_token"
        assert tokens.token_type == "bearer"
        # GitHub doesn't return refresh_token or expires_in by default
        assert tokens.refresh_token is None
        assert tokens.expires_in == 0

        # Verify the correct payload was sent
        mock_client.post.assert_called_once()
        call_kwargs = mock_client.post.call_args
        assert call_kwargs[0][0] == "https://github.com/login/oauth/access_token"
        sent_json = call_kwargs[1]["json"]
        assert sent_json["client_id"] == "gh-client-id"
        assert sent_json["client_secret"] == "gh-client-secret"
        assert sent_json["code"] == "auth-code-123"
        assert sent_json["redirect_uri"] == "https://myapp.com/callback"

    @pytest.mark.asyncio
    async def test_exchange_code_error_response(self) -> None:
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "error": "bad_verification_code",
            "error_description": "The code passed is incorrect or expired.",
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "pqdb_api.services.oauth.httpx.AsyncClient", return_value=mock_client
        ):
            with pytest.raises(ValueError, match="bad_verification_code"):
                await provider.exchange_code(
                    code="bad-code",
                    redirect_uri="https://myapp.com/callback",
                )

    @pytest.mark.asyncio
    async def test_exchange_code_http_error(self) -> None:
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 500
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Server Error",
            request=MagicMock(),
            response=mock_response,
        )

        mock_client = AsyncMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "pqdb_api.services.oauth.httpx.AsyncClient", return_value=mock_client
        ):
            with pytest.raises(httpx.HTTPStatusError):
                await provider.exchange_code(
                    code="code",
                    redirect_uri="https://myapp.com/callback",
                )


class TestGitHubOAuthProviderGetUserInfo:
    """Tests for GitHubOAuthProvider.get_user_info."""

    @pytest.mark.asyncio
    async def test_get_user_info_with_public_email(self) -> None:
        """When /user returns a verified email, use it directly."""
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        tokens = OAuthTokens(
            access_token="gho_test_token",
            refresh_token=None,
            expires_in=0,
            token_type="bearer",
        )

        user_response = MagicMock(spec=httpx.Response)
        user_response.status_code = 200
        user_response.json.return_value = {
            "id": 12345,
            "login": "testuser",
            "name": "Test User",
            "email": "test@example.com",
            "avatar_url": "https://avatars.githubusercontent.com/u/12345",
        }
        user_response.raise_for_status = MagicMock()

        emails_response = MagicMock(spec=httpx.Response)
        emails_response.status_code = 200
        emails_response.json.return_value = [
            {
                "email": "test@example.com",
                "primary": True,
                "verified": True,
                "visibility": "public",
            },
        ]
        emails_response.raise_for_status = MagicMock()

        mock_client = AsyncMock(spec=httpx.AsyncClient)

        async def _mock_get(url: str, **kwargs: object) -> MagicMock:
            if url == "https://api.github.com/user":
                return user_response
            if url == "https://api.github.com/user/emails":
                return emails_response
            raise ValueError(f"Unexpected URL: {url}")

        mock_client.get = AsyncMock(side_effect=_mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "pqdb_api.services.oauth.httpx.AsyncClient", return_value=mock_client
        ):
            info = await provider.get_user_info(tokens)

        assert isinstance(info, OAuthUserInfo)
        assert info.email == "test@example.com"
        assert info.name == "Test User"
        assert info.provider_uid == "12345"
        assert info.avatar_url == "https://avatars.githubusercontent.com/u/12345"

    @pytest.mark.asyncio
    async def test_get_user_info_with_private_email(self) -> None:
        """When /user has no email, fetch from /user/emails endpoint."""
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        tokens = OAuthTokens(
            access_token="gho_test_token",
            refresh_token=None,
            expires_in=0,
            token_type="bearer",
        )

        user_response = MagicMock(spec=httpx.Response)
        user_response.status_code = 200
        user_response.json.return_value = {
            "id": 67890,
            "login": "privateuser",
            "name": "Private User",
            "email": None,
            "avatar_url": "https://avatars.githubusercontent.com/u/67890",
        }
        user_response.raise_for_status = MagicMock()

        emails_response = MagicMock(spec=httpx.Response)
        emails_response.status_code = 200
        emails_response.json.return_value = [
            {"email": "noreply@github.com", "primary": False, "verified": True},
            {"email": "private@example.com", "primary": True, "verified": True},
        ]
        emails_response.raise_for_status = MagicMock()

        mock_client = AsyncMock(spec=httpx.AsyncClient)

        async def _mock_get(url: str, **kwargs: object) -> MagicMock:
            if url == "https://api.github.com/user":
                return user_response
            if url == "https://api.github.com/user/emails":
                return emails_response
            raise ValueError(f"Unexpected URL: {url}")

        mock_client.get = AsyncMock(side_effect=_mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "pqdb_api.services.oauth.httpx.AsyncClient", return_value=mock_client
        ):
            info = await provider.get_user_info(tokens)

        assert info.email == "private@example.com"
        assert info.name == "Private User"
        assert info.provider_uid == "67890"

    @pytest.mark.asyncio
    async def test_get_user_info_no_verified_email_raises(self) -> None:
        """When no verified primary email is found, raise ValueError."""
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        tokens = OAuthTokens(
            access_token="gho_test_token",
            refresh_token=None,
            expires_in=0,
            token_type="bearer",
        )

        user_response = MagicMock(spec=httpx.Response)
        user_response.status_code = 200
        user_response.json.return_value = {
            "id": 99999,
            "login": "noemail",
            "name": None,
            "email": None,
            "avatar_url": None,
        }
        user_response.raise_for_status = MagicMock()

        emails_response = MagicMock(spec=httpx.Response)
        emails_response.status_code = 200
        emails_response.json.return_value = [
            {"email": "unverified@example.com", "primary": True, "verified": False},
        ]
        emails_response.raise_for_status = MagicMock()

        mock_client = AsyncMock(spec=httpx.AsyncClient)

        async def _mock_get(url: str, **kwargs: object) -> MagicMock:
            if url == "https://api.github.com/user":
                return user_response
            if url == "https://api.github.com/user/emails":
                return emails_response
            raise ValueError(f"Unexpected URL: {url}")

        mock_client.get = AsyncMock(side_effect=_mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "pqdb_api.services.oauth.httpx.AsyncClient", return_value=mock_client
        ):
            with pytest.raises(ValueError, match="No verified primary email"):
                await provider.get_user_info(tokens)

    @pytest.mark.asyncio
    async def test_get_user_info_sends_auth_header(self) -> None:
        """Verify Authorization header is sent with the access token."""
        provider = GitHubOAuthProvider(
            client_id="gh-client-id",
            client_secret="gh-client-secret",
        )
        tokens = OAuthTokens(
            access_token="gho_my_token",
            refresh_token=None,
            expires_in=0,
            token_type="bearer",
        )

        user_response = MagicMock(spec=httpx.Response)
        user_response.status_code = 200
        user_response.json.return_value = {
            "id": 1,
            "login": "u",
            "name": "U",
            "email": "u@example.com",
            "avatar_url": None,
        }
        user_response.raise_for_status = MagicMock()

        emails_response = MagicMock(spec=httpx.Response)
        emails_response.status_code = 200
        emails_response.json.return_value = [
            {"email": "u@example.com", "primary": True, "verified": True},
        ]
        emails_response.raise_for_status = MagicMock()

        mock_client = AsyncMock(spec=httpx.AsyncClient)

        async def _mock_get(url: str, **kwargs: object) -> MagicMock:
            if url == "https://api.github.com/user":
                return user_response
            return emails_response

        mock_client.get = AsyncMock(side_effect=_mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "pqdb_api.services.oauth.httpx.AsyncClient", return_value=mock_client
        ):
            await provider.get_user_info(tokens)

        # All calls should have the Authorization header
        for call in mock_client.get.call_args_list:
            headers = call[1].get("headers", {})
            assert headers.get("Authorization") == "Bearer gho_my_token"
