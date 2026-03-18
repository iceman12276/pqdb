"""Unit tests for VaultClient platform OAuth credential methods."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from pqdb_api.services.vault import VaultClient, VaultError


@pytest.fixture()
def vault() -> VaultClient:
    """Create a VaultClient with a mocked hvac client."""
    with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
        client = VaultClient(vault_addr="http://localhost:8200", vault_token="test")
        client._client = mock_hvac()
        return client


class TestStorePlatformOAuthCredentials:
    def test_stores_at_platform_path(self, vault: VaultClient) -> None:
        creds = {"client_id": "gid", "client_secret": "gsecret"}
        vault.store_platform_oauth_credentials("google", creds)
        vault._client.secrets.kv.v2.create_or_update_secret.assert_called_once_with(
            path="pqdb/platform/oauth/google",
            secret=creds,
        )

    def test_raises_vault_error_on_failure(self, vault: VaultClient) -> None:
        vault._client.secrets.kv.v2.create_or_update_secret.side_effect = Exception(
            "write fail"
        )
        with pytest.raises(VaultError, match="Failed to store"):
            vault.store_platform_oauth_credentials(
                "github", {"client_id": "x", "client_secret": "y"}
            )


class TestGetPlatformOAuthCredentials:
    def test_reads_from_platform_path(self, vault: VaultClient) -> None:
        creds = {"client_id": "gid", "client_secret": "gsecret"}
        vault._client.secrets.kv.v2.read_secret_version.return_value = {
            "data": {"data": creds}
        }
        result = vault.get_platform_oauth_credentials("google")
        assert result == creds
        vault._client.secrets.kv.v2.read_secret_version.assert_called_once_with(
            path="pqdb/platform/oauth/google",
            raise_on_deleted_version=True,
        )

    def test_raises_vault_error_on_failure(self, vault: VaultClient) -> None:
        vault._client.secrets.kv.v2.read_secret_version.side_effect = Exception(
            "read fail"
        )
        with pytest.raises(VaultError, match="Failed to retrieve"):
            vault.get_platform_oauth_credentials("google")

    def test_reraises_vault_error(self, vault: VaultClient) -> None:
        vault._client.secrets.kv.v2.read_secret_version.side_effect = VaultError(
            "already vault"
        )
        with pytest.raises(VaultError, match="already vault"):
            vault.get_platform_oauth_credentials("google")


class TestDeletePlatformOAuthCredentials:
    def test_deletes_from_platform_path(self, vault: VaultClient) -> None:
        vault.delete_platform_oauth_credentials("github")
        vault._client.secrets.kv.v2.delete_metadata_and_all_versions.assert_called_once_with(
            path="pqdb/platform/oauth/github",
        )

    def test_raises_vault_error_on_failure(self, vault: VaultClient) -> None:
        vault._client.secrets.kv.v2.delete_metadata_and_all_versions.side_effect = (
            Exception("delete fail")
        )
        with pytest.raises(VaultError, match="Failed to delete"):
            vault.delete_platform_oauth_credentials("google")
