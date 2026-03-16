"""Unit tests for VaultClient OAuth credential storage methods."""

import uuid
from unittest.mock import MagicMock, patch

import pytest

from pqdb_api.services.vault import VaultClient, VaultError


class TestStoreOAuthCredentials:
    """Tests for VaultClient.store_oauth_credentials."""

    def test_stores_credentials_at_correct_path(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            credentials = {"client_id": "gid", "client_secret": "gsecret"}

            client.store_oauth_credentials(project_id, "google", credentials)

            call_args = (
                mock_client_instance.secrets.kv.v2.create_or_update_secret.call_args
            )
            assert (
                call_args.kwargs["path"] == f"pqdb/projects/{project_id}/oauth/google"
            )
            assert call_args.kwargs["secret"] == credentials

    def test_raises_vault_error_on_failure(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance
            mock_client_instance.secrets.kv.v2.create_or_update_secret.side_effect = (
                Exception("connection refused")
            )

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.uuid4()
            with pytest.raises(VaultError, match="Failed to store OAuth credentials"):
                client.store_oauth_credentials(project_id, "google", {"client_id": "x"})


class TestGetOAuthCredentials:
    """Tests for VaultClient.get_oauth_credentials."""

    def test_reads_from_correct_path(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            credentials = {"client_id": "gid", "client_secret": "gsecret"}
            mock_client_instance.secrets.kv.v2.read_secret_version.return_value = {
                "data": {"data": credentials}
            }

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            result = client.get_oauth_credentials(project_id, "google")

            assert result == credentials
            call_args = mock_client_instance.secrets.kv.v2.read_secret_version.call_args
            assert (
                call_args.kwargs["path"] == f"pqdb/projects/{project_id}/oauth/google"
            )

    def test_raises_vault_error_on_failure(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance
            mock_client_instance.secrets.kv.v2.read_secret_version.side_effect = (
                Exception("not found")
            )

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.uuid4()
            with pytest.raises(
                VaultError, match="Failed to retrieve OAuth credentials"
            ):
                client.get_oauth_credentials(project_id, "google")


class TestDeleteOAuthCredentials:
    """Tests for VaultClient.delete_oauth_credentials."""

    def test_deletes_at_correct_path(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            client.delete_oauth_credentials(project_id, "google")

            mock_client_instance.secrets.kv.v2.delete_metadata_and_all_versions.assert_called_once_with(
                path=f"pqdb/projects/{project_id}/oauth/google",
            )

    def test_raises_vault_error_on_failure(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance
            kv = mock_client_instance.secrets.kv.v2
            kv.delete_metadata_and_all_versions.side_effect = Exception(
                "connection refused"
            )

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.uuid4()
            with pytest.raises(VaultError, match="Failed to delete OAuth credentials"):
                client.delete_oauth_credentials(project_id, "google")


class TestListOAuthProviders:
    """Tests for VaultClient.list_oauth_providers."""

    def test_lists_providers_from_vault(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            mock_client_instance.secrets.kv.v2.list_secrets.return_value = {
                "data": {"keys": ["google/", "github/"]}
            }

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            result = client.list_oauth_providers(project_id)

            assert result == ["google", "github"]
            call_args = mock_client_instance.secrets.kv.v2.list_secrets.call_args
            assert call_args.kwargs["path"] == f"pqdb/projects/{project_id}/oauth"

    def test_returns_empty_list_when_none_configured(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            mock_client_instance.secrets.kv.v2.list_secrets.side_effect = Exception(
                "not found"
            )

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.uuid4()
            result = client.list_oauth_providers(project_id)
            assert result == []
