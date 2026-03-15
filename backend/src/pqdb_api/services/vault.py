"""HashiCorp Vault client for HMAC key management.

Stores per-project HMAC keys at secret/pqdb/projects/{project_id}/hmac
using the KV v2 secrets engine.

Versioned format:
{
    "current_version": N,
    "keys": {
        "1": { "key": "hex", "created_at": "iso8601" },
        ...
    }
}

Legacy (unversioned) format { "key": "hex" } is auto-migrated on first read.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import hvac
import structlog

logger = structlog.get_logger()


class VaultError(Exception):
    """Raised when a Vault operation fails."""


@dataclass(frozen=True)
class VersionedHmacKeys:
    """All HMAC keys for a project with current version indicator."""

    current_version: int
    keys: dict[str, str]  # version_number -> key_hex


class VaultClient:
    """Wraps hvac to manage per-project HMAC keys in Vault."""

    def __init__(self, vault_addr: str, vault_token: str) -> None:
        self._client: hvac.Client = hvac.Client(
            url=vault_addr,
            token=vault_token,
        )

    def store_hmac_key(self, project_id: uuid.UUID, key: bytes) -> None:
        """Store an HMAC key in Vault for the given project.

        Writes in versioned format with version 1.
        """
        path = f"pqdb/projects/{project_id}/hmac"
        now = datetime.now(timezone.utc).isoformat()
        secret: dict[str, Any] = {
            "current_version": 1,
            "keys": {
                "1": {
                    "key": key.hex(),
                    "created_at": now,
                },
            },
        }
        try:
            self._client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret=secret,
            )
            logger.info(
                "hmac_key_stored",
                project_id=str(project_id),
                version=1,
            )
        except Exception as exc:
            logger.error(
                "hmac_key_store_failed",
                project_id=str(project_id),
                error=str(exc),
            )
            raise VaultError(f"Failed to store HMAC key: {exc}") from exc

    def _read_raw(self, project_id: uuid.UUID) -> dict[str, Any]:
        """Read raw secret data from Vault."""
        path = f"pqdb/projects/{project_id}/hmac"
        response = self._client.secrets.kv.v2.read_secret_version(
            path=path,
            raise_on_deleted_version=True,
        )
        data: dict[str, Any] = response["data"]["data"]
        return data

    def _is_versioned(self, data: dict[str, Any]) -> bool:
        """Check if the stored data uses the versioned format."""
        return "current_version" in data and "keys" in data

    def _migrate_to_versioned(
        self, project_id: uuid.UUID, data: dict[str, Any]
    ) -> dict[str, Any]:
        """Migrate unversioned { key: hex } to versioned format and write back."""
        now = datetime.now(timezone.utc).isoformat()
        versioned: dict[str, Any] = {
            "current_version": 1,
            "keys": {
                "1": {
                    "key": data["key"],
                    "created_at": now,
                },
            },
        }
        path = f"pqdb/projects/{project_id}/hmac"
        self._client.secrets.kv.v2.create_or_update_secret(
            path=path,
            secret=versioned,
        )
        logger.info(
            "hmac_key_migrated_to_versioned",
            project_id=str(project_id),
        )
        return versioned

    def get_hmac_key(self, project_id: uuid.UUID) -> bytes:
        """Retrieve the current HMAC key for the given project from Vault.

        Returns the key as raw bytes. Auto-migrates unversioned format.
        """
        try:
            data = self._read_raw(project_id)
            if not self._is_versioned(data):
                data = self._migrate_to_versioned(project_id, data)
            current = str(data["current_version"])
            key_hex: str = data["keys"][current]["key"]
            return bytes.fromhex(key_hex)
        except VaultError:
            raise
        except Exception as exc:
            logger.error(
                "hmac_key_retrieve_failed",
                project_id=str(project_id),
                error=str(exc),
            )
            raise VaultError(f"Failed to retrieve HMAC key: {exc}") from exc

    def get_hmac_keys(self, project_id: uuid.UUID) -> VersionedHmacKeys:
        """Retrieve all HMAC keys for a project with version metadata.

        Returns VersionedHmacKeys with current_version and all key hex strings.
        Auto-migrates unversioned format on first read.
        """
        try:
            data = self._read_raw(project_id)
            if not self._is_versioned(data):
                data = self._migrate_to_versioned(project_id, data)
            current_version: int = data["current_version"]
            keys: dict[str, str] = {
                ver: info["key"] for ver, info in data["keys"].items()
            }
            return VersionedHmacKeys(current_version=current_version, keys=keys)
        except VaultError:
            raise
        except Exception as exc:
            logger.error(
                "hmac_keys_retrieve_failed",
                project_id=str(project_id),
                error=str(exc),
            )
            raise VaultError(f"Failed to retrieve HMAC keys: {exc}") from exc

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
