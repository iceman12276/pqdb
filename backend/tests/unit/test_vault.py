"""Unit tests for VaultClient service."""

import uuid
from unittest.mock import MagicMock, patch

import pytest

from pqdb_api.services.vault import VaultClient, VaultError, VersionedHmacKeys


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
    """Tests for VaultClient.store_hmac_key — now writes versioned format."""

    def test_store_hmac_key_writes_versioned_format(self) -> None:
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

            call_args = (
                mock_client_instance.secrets.kv.v2.create_or_update_secret.call_args
            )
            secret = call_args.kwargs["secret"]
            assert secret["current_version"] == 1
            assert "1" in secret["keys"]
            assert secret["keys"]["1"]["key"] == key.hex()
            assert "created_at" in secret["keys"]["1"]

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

            call_args = (
                mock_client_instance.secrets.kv.v2.create_or_update_secret.call_args
            )
            assert call_args.kwargs["path"] == f"pqdb/projects/{project_id}/hmac"

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
    """Tests for VaultClient.get_hmac_key — backward compatible."""

    def test_get_hmac_key_from_versioned_format(self) -> None:
        """get_hmac_key returns the current version's key bytes."""
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            key_hex = "ab" * 32
            mock_client_instance.secrets.kv.v2.read_secret_version.return_value = {
                "data": {
                    "data": {
                        "current_version": 1,
                        "keys": {
                            "1": {
                                "key": key_hex,
                                "created_at": "2026-01-01T00:00:00Z",
                            }
                        },
                    }
                }
            }

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            result = client.get_hmac_key(project_id)
            assert result == bytes.fromhex(key_hex)

    def test_get_hmac_key_auto_migrates_unversioned(self) -> None:
        """Legacy unversioned format { key: hex } is auto-migrated."""
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            key_hex = "cd" * 32
            mock_client_instance.secrets.kv.v2.read_secret_version.return_value = {
                "data": {"data": {"key": key_hex}}
            }

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            result = client.get_hmac_key(project_id)
            assert result == bytes.fromhex(key_hex)

            # Should have written back the migrated versioned format
            write_call = (
                mock_client_instance.secrets.kv.v2.create_or_update_secret.call_args
            )
            migrated = write_call.kwargs["secret"]
            assert migrated["current_version"] == 1
            assert migrated["keys"]["1"]["key"] == key_hex

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


class TestGetHmacKeys:
    """Tests for VaultClient.get_hmac_keys — returns all versioned keys."""

    def test_get_hmac_keys_returns_versioned_keys(self) -> None:
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            key1_hex = "ab" * 32
            key2_hex = "cd" * 32
            mock_client_instance.secrets.kv.v2.read_secret_version.return_value = {
                "data": {
                    "data": {
                        "current_version": 2,
                        "keys": {
                            "1": {
                                "key": key1_hex,
                                "created_at": "2026-01-01T00:00:00Z",
                            },
                            "2": {
                                "key": key2_hex,
                                "created_at": "2026-02-01T00:00:00Z",
                            },
                        },
                    }
                }
            }

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            result = client.get_hmac_keys(project_id)

            assert result.current_version == 2
            assert result.keys == {"1": key1_hex, "2": key2_hex}

    def test_get_hmac_keys_auto_migrates_unversioned(self) -> None:
        """Legacy unversioned format is auto-migrated and returned."""
        with patch("pqdb_api.services.vault.hvac.Client") as mock_hvac:
            mock_client_instance = MagicMock()
            mock_hvac.return_value = mock_client_instance

            key_hex = "ef" * 32
            mock_client_instance.secrets.kv.v2.read_secret_version.return_value = {
                "data": {"data": {"key": key_hex}}
            }

            client = VaultClient(
                vault_addr="http://localhost:8200",
                vault_token="test-token",
            )

            project_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
            result = client.get_hmac_keys(project_id)

            assert result.current_version == 1
            assert result.keys == {"1": key_hex}

            # Should have written back the migrated format
            write_call = (
                mock_client_instance.secrets.kv.v2.create_or_update_secret.call_args
            )
            assert write_call is not None

    def test_get_hmac_keys_raises_vault_error_on_failure(self) -> None:
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

            with pytest.raises(VaultError, match="Failed to retrieve HMAC keys"):
                client.get_hmac_keys(project_id)


class TestVersionedHmacKeys:
    """Tests for the VersionedHmacKeys data class."""

    def test_versioned_hmac_keys_fields(self) -> None:
        keys = VersionedHmacKeys(current_version=2, keys={"1": "aa", "2": "bb"})
        assert keys.current_version == 2
        assert keys.keys == {"1": "aa", "2": "bb"}


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
