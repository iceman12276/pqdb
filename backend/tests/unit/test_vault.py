"""Unit tests for VaultClient service."""

import uuid
from unittest.mock import MagicMock, patch

import pytest

from pqdb_api.services.vault import VaultClient, VaultError


class TestVaultClientInit:
    """VaultClient initialization."""

    def test_creates_client_with_url_and_token(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )
            mock_hvac.assert_called_once_with(
                url="http://localhost:8200",
                token="test-token",
            )
            assert client._client is not None


class TestStoreHmacKey:
    """Tests for VaultClient.store_hmac_key."""

    def test_store_hmac_key_writes_to_correct_path(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            key = b"\x00" * 32

            client.store_hmac_key(project_id, key)

            mock_client_instance.secrets.kv.v2.create_or_update_secret.assert_called_once_with(
                path=f"pqdb/projects/{project_id}/hmac",
                secret={"key": key.hex()},
            )

    def test_store_hmac_key_raises_vault_error_on_failure(self) -> None:
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
            key = b"\x00" * 32

            with pytest.raises(VaultError, match="Failed to store HMAC key"):
                client.store_hmac_key(project_id, key)


class TestGetHmacKey:
    """Tests for VaultClient.get_hmac_key."""

    def test_get_hmac_key_reads_from_correct_path(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            key_hex = "ab" * 32
            mock_client_instance.secrets.kv.v2.read_secret_version.return_value = {
                "data": {"data": {"key": key_hex}}
            }

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            result = client.get_hmac_key(project_id)

            mock_client_instance.secrets.kv.v2.read_secret_version.assert_called_once_with(
                path=f"pqdb/projects/{project_id}/hmac",
                raise_on_deleted_version=True,
            )
            assert result == bytes.fromhex(key_hex)

    def test_get_hmac_key_raises_vault_error_on_failure(self) -> None:
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

            with pytest.raises(VaultError, match="Failed to retrieve HMAC key"):
                client.get_hmac_key(project_id)


class TestDeleteHmacKey:
    """Tests for VaultClient.delete_hmac_key."""

    def test_delete_hmac_key_deletes_correct_path(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            client.delete_hmac_key(project_id)

            mock_client_instance.secrets.kv.v2.delete_metadata_and_all_versions.assert_called_once_with(
                path=f"pqdb/projects/{project_id}/hmac",
            )

    def test_delete_hmac_key_raises_vault_error_on_failure(self) -> None:
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

            with pytest.raises(VaultError, match="Failed to delete HMAC key"):
                client.delete_hmac_key(project_id)
