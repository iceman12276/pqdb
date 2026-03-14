"""HashiCorp Vault client for HMAC key management.

Stores per-project HMAC keys at secret/pqdb/projects/{project_id}/hmac
using the KV v2 secrets engine.
"""

from __future__ import annotations

import uuid

import hvac
import structlog

logger = structlog.get_logger()


class VaultError(Exception):
    """Raised when a Vault operation fails."""


class VaultClient:
    """Wraps hvac to manage per-project HMAC keys in Vault."""

    def __init__(self, vault_addr: str, vault_token: str) -> None:
        self._client: hvac.Client = hvac.Client(
            url=vault_addr,
            token=vault_token,
        )

    def store_hmac_key(self, project_id: uuid.UUID, key: bytes) -> None:
        """Store an HMAC key in Vault for the given project.

        The key is stored as a hex string at
        secret/pqdb/projects/{project_id}/hmac.
        """
        path = f"pqdb/projects/{project_id}/hmac"
        try:
            self._client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret={"key": key.hex()},
            )
            logger.info(
                "hmac_key_stored",
                project_id=str(project_id),
            )
        except Exception as exc:
            logger.error(
                "hmac_key_store_failed",
                project_id=str(project_id),
                error=str(exc),
            )
            raise VaultError(f"Failed to store HMAC key: {exc}") from exc

    def get_hmac_key(self, project_id: uuid.UUID) -> bytes:
        """Retrieve the HMAC key for the given project from Vault.

        Returns the key as raw bytes.
        """
        path = f"pqdb/projects/{project_id}/hmac"
        try:
            response = self._client.secrets.kv.v2.read_secret_version(
                path=path,
                raise_on_deleted_version=True,
            )
            key_hex: str = response["data"]["data"]["key"]
            return bytes.fromhex(key_hex)
        except Exception as exc:
            logger.error(
                "hmac_key_retrieve_failed",
                project_id=str(project_id),
                error=str(exc),
            )
            raise VaultError(f"Failed to retrieve HMAC key: {exc}") from exc

    def delete_hmac_key(self, project_id: uuid.UUID) -> None:
        """Delete the HMAC key for the given project from Vault."""
        path = f"pqdb/projects/{project_id}/hmac"
        try:
            self._client.secrets.kv.v2.delete_metadata_and_all_versions(
                path=path,
            )
            logger.info(
                "hmac_key_deleted",
                project_id=str(project_id),
            )
        except Exception as exc:
            logger.error(
                "hmac_key_delete_failed",
                project_id=str(project_id),
                error=str(exc),
            )
            raise VaultError(f"Failed to delete HMAC key: {exc}") from exc
