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

import secrets
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
        try:
            self._client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret=versioned,
            )
            logger.info(
                "hmac_key_migrated_to_versioned",
                project_id=str(project_id),
            )
        except Exception as exc:
            logger.warning(
                "hmac_key_migration_write_failed",
                project_id=str(project_id),
                error=str(exc),
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

    def rotate_hmac_key(self, project_id: uuid.UUID) -> VersionedHmacKeys:
        """Generate a new HMAC key version for a project.

        Reads existing keys, generates a new 256-bit key, increments
        current_version, writes back, and returns all keys.
        """
        try:
            data = self._read_raw(project_id)
            if not self._is_versioned(data):
                data = self._migrate_to_versioned(project_id, data)

            current_version: int = data["current_version"]
            new_version = current_version + 1
            new_key = secrets.token_bytes(32)
            now = datetime.now(timezone.utc).isoformat()

            data["keys"][str(new_version)] = {
                "key": new_key.hex(),
                "created_at": now,
            }
            data["current_version"] = new_version

            path = f"pqdb/projects/{project_id}/hmac"
            self._client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret=data,
            )

            logger.info(
                "hmac_key_rotated",
                project_id=str(project_id),
                previous_version=current_version,
                current_version=new_version,
            )

            keys: dict[str, str] = {
                ver: info["key"] for ver, info in data["keys"].items()
            }
            return VersionedHmacKeys(current_version=new_version, keys=keys)
        except VaultError:
            raise
        except Exception as exc:
            logger.error(
                "hmac_key_rotate_failed",
                project_id=str(project_id),
                error=str(exc),
            )
            raise VaultError(f"Failed to rotate HMAC key: {exc}") from exc

    def delete_hmac_key_version(
        self, project_id: uuid.UUID, version: int
    ) -> VersionedHmacKeys:
        """Delete a specific HMAC key version from a project.

        Cannot delete the current version. Reads existing keys, removes the
        specified version, writes back, and returns the updated keys.

        Raises VaultError if the version is the current one or not found.
        """
        try:
            data = self._read_raw(project_id)
            if not self._is_versioned(data):
                data = self._migrate_to_versioned(project_id, data)

            current_version: int = data["current_version"]
            if version == current_version:
                raise VaultError(f"Cannot delete current key version {version}")

            version_str = str(version)
            if version_str not in data["keys"]:
                raise VaultError(f"Key version {version} not found")

            del data["keys"][version_str]

            path = f"pqdb/projects/{project_id}/hmac"
            self._client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret=data,
            )

            logger.info(
                "hmac_key_version_deleted",
                project_id=str(project_id),
                deleted_version=version,
            )

            keys: dict[str, str] = {
                ver: info["key"] for ver, info in data["keys"].items()
            }
            return VersionedHmacKeys(current_version=current_version, keys=keys)
        except VaultError:
            raise
        except Exception as exc:
            logger.error(
                "hmac_key_version_delete_failed",
                project_id=str(project_id),
                version=version,
                error=str(exc),
            )
            raise VaultError(f"Failed to delete HMAC key version: {exc}") from exc

    # ------------------------------------------------------------------
    # OAuth credential management
    # ------------------------------------------------------------------

    def store_oauth_credentials(
        self,
        project_id: uuid.UUID,
        provider: str,
        credentials: dict[str, Any],
    ) -> None:
        """Store OAuth provider credentials in Vault.

        Writes to secret/pqdb/projects/{project_id}/oauth/{provider}.
        """
        path = f"pqdb/projects/{project_id}/oauth/{provider}"
        try:
            self._client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret=credentials,
            )
            logger.info(
                "oauth_credentials_stored",
                project_id=str(project_id),
                provider=provider,
            )
        except Exception as exc:
            logger.error(
                "oauth_credentials_store_failed",
                project_id=str(project_id),
                provider=provider,
                error=str(exc),
            )
            raise VaultError(f"Failed to store OAuth credentials: {exc}") from exc

    def get_oauth_credentials(
        self, project_id: uuid.UUID, provider: str
    ) -> dict[str, Any]:
        """Retrieve OAuth provider credentials from Vault."""
        path = f"pqdb/projects/{project_id}/oauth/{provider}"
        try:
            response = self._client.secrets.kv.v2.read_secret_version(
                path=path,
                raise_on_deleted_version=True,
            )
            data: dict[str, Any] = response["data"]["data"]
            return data
        except VaultError:
            raise
        except Exception as exc:
            logger.error(
                "oauth_credentials_retrieve_failed",
                project_id=str(project_id),
                provider=provider,
                error=str(exc),
            )
            raise VaultError(f"Failed to retrieve OAuth credentials: {exc}") from exc

    def delete_oauth_credentials(self, project_id: uuid.UUID, provider: str) -> None:
        """Delete OAuth provider credentials from Vault."""
        path = f"pqdb/projects/{project_id}/oauth/{provider}"
        try:
            self._client.secrets.kv.v2.delete_metadata_and_all_versions(
                path=path,
            )
            logger.info(
                "oauth_credentials_deleted",
                project_id=str(project_id),
                provider=provider,
            )
        except Exception as exc:
            logger.error(
                "oauth_credentials_delete_failed",
                project_id=str(project_id),
                provider=provider,
                error=str(exc),
            )
            raise VaultError(f"Failed to delete OAuth credentials: {exc}") from exc

    def list_oauth_providers(self, project_id: uuid.UUID) -> list[str]:
        """List configured OAuth providers for a project.

        Returns provider names (e.g. ["google", "github"]).
        Returns empty list if no providers are configured.
        """
        path = f"pqdb/projects/{project_id}/oauth"
        try:
            response = self._client.secrets.kv.v2.list_secrets(
                path=path,
            )
            keys: list[str] = response["data"]["keys"]
            # Vault returns keys with trailing slash for directories
            return [k.rstrip("/") for k in keys]
        except Exception:
            # No providers configured or path doesn't exist
            return []

    # ------------------------------------------------------------------
    # Platform OAuth credential management (developer login)
    # ------------------------------------------------------------------

    def store_platform_oauth_credentials(
        self,
        provider: str,
        credentials: dict[str, Any],
    ) -> None:
        """Store platform-level OAuth provider credentials in Vault.

        Writes to secret/pqdb/platform/oauth/{provider}.
        Used for developer login (not project-scoped end-user OAuth).
        """
        path = f"pqdb/platform/oauth/{provider}"
        try:
            self._client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret=credentials,
            )
            logger.info(
                "platform_oauth_credentials_stored",
                provider=provider,
            )
        except Exception as exc:
            logger.error(
                "platform_oauth_credentials_store_failed",
                provider=provider,
                error=str(exc),
            )
            raise VaultError(
                f"Failed to store platform OAuth credentials: {exc}"
            ) from exc

    def get_platform_oauth_credentials(self, provider: str) -> dict[str, Any]:
        """Retrieve platform-level OAuth provider credentials from Vault."""
        path = f"pqdb/platform/oauth/{provider}"
        try:
            response = self._client.secrets.kv.v2.read_secret_version(
                path=path,
                raise_on_deleted_version=True,
            )
            data: dict[str, Any] = response["data"]["data"]
            return data
        except VaultError:
            raise
        except Exception as exc:
            logger.error(
                "platform_oauth_credentials_retrieve_failed",
                provider=provider,
                error=str(exc),
            )
            raise VaultError(
                f"Failed to retrieve platform OAuth credentials: {exc}"
            ) from exc

    def delete_platform_oauth_credentials(self, provider: str) -> None:
        """Delete platform-level OAuth provider credentials from Vault."""
        path = f"pqdb/platform/oauth/{provider}"
        try:
            self._client.secrets.kv.v2.delete_metadata_and_all_versions(
                path=path,
            )
            logger.info(
                "platform_oauth_credentials_deleted",
                provider=provider,
            )
        except Exception as exc:
            logger.error(
                "platform_oauth_credentials_delete_failed",
                provider=provider,
                error=str(exc),
            )
            raise VaultError(
                f"Failed to delete platform OAuth credentials: {exc}"
            ) from exc

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
