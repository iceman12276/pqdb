"""API key generation and management service."""

import secrets
import uuid
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.models.api_key import ApiKey

_hasher = PasswordHasher()

_KEY_RANDOM_BYTES = 24  # 24 bytes -> 32 chars in base64url

_VALID_OPERATIONS = frozenset({"select", "insert", "update", "delete"})


def validate_permissions(permissions: object) -> str | None:
    """Validate a permissions schema.

    Returns None if valid, or an error message string if invalid.
    Expected format: {"tables": {"tablename": ["select", "insert", ...]}}
    """
    if not isinstance(permissions, dict):
        return "Permissions must be a JSON object"

    if set(permissions.keys()) != {"tables"}:
        return "Permissions must contain exactly the 'tables' key"

    tables = permissions["tables"]
    if not isinstance(tables, dict):
        return "Tables must be a JSON object mapping table names to operations"

    if len(tables) == 0:
        return "Tables must contain at least one table"

    for table_name, operations in tables.items():
        if not isinstance(table_name, str) or not table_name:
            return "Table names must be non-empty strings"

        if not isinstance(operations, list):
            return f"Operations for table '{table_name}' must be a list"

        if len(operations) == 0:
            return f"Operations for table '{table_name}' must not be empty"

        for op in operations:
            if not isinstance(op, str):
                return f"Operations for table '{table_name}' must be strings"

        invalid = set(operations) - _VALID_OPERATIONS
        if invalid:
            sorted_invalid = sorted(invalid)
            return (
                f"Invalid operations for table '{table_name}': "
                f"{', '.join(sorted_invalid)}. "
                f"Allowed: select, insert, update, delete"
            )

        if len(operations) != len(set(operations)):
            return f"Duplicate operations for table '{table_name}'"

    return None


def generate_api_key(role: str) -> str:
    """Generate a new API key in the format pqdb_{role}_{random_32_chars}."""
    random_part = secrets.token_urlsafe(_KEY_RANDOM_BYTES)
    return f"pqdb_{role}_{random_part}"


def hash_api_key(key: str) -> str:
    """Hash an API key using argon2id."""
    return _hasher.hash(key)


def verify_api_key(key_hash: str, key: str) -> bool:
    """Verify an API key against its argon2id hash."""
    try:
        return _hasher.verify(key_hash, key)
    except VerifyMismatchError:
        return False


async def create_project_keys(
    project_id: uuid.UUID, session: AsyncSession
) -> list[dict[str, str]]:
    """Create both anon and service_role keys for a project.

    Returns the full keys (one-time display). Keys are stored as hashes.
    """
    results: list[dict[str, str]] = []
    for role in ("anon", "service"):
        full_key = generate_api_key(role)
        key_hash = hash_api_key(full_key)
        key_prefix = full_key[:8]

        api_key = ApiKey(
            id=uuid.uuid4(),
            project_id=project_id,
            key_hash=key_hash,
            key_prefix=key_prefix,
            role=role,
        )
        session.add(api_key)
        results.append(
            {
                "id": str(api_key.id),
                "role": role,
                "key": full_key,
                "key_prefix": key_prefix,
            }
        )
    return results


async def create_single_key(
    project_id: uuid.UUID, role: str, session: AsyncSession
) -> dict[str, str]:
    """Create a single API key for a project.

    Returns the full key info (one-time display). Key is stored as a hash.
    """
    full_key = generate_api_key(role)
    key_hash = hash_api_key(full_key)
    key_prefix = full_key[:8]

    api_key = ApiKey(
        id=uuid.uuid4(),
        project_id=project_id,
        key_hash=key_hash,
        key_prefix=key_prefix,
        role=role,
    )
    session.add(api_key)
    return {
        "id": str(api_key.id),
        "role": role,
        "key": full_key,
        "key_prefix": key_prefix,
    }


async def list_project_keys(
    project_id: uuid.UUID, session: AsyncSession
) -> list[ApiKey]:
    """List all API keys for a project (returns model objects, not full keys)."""
    result = await session.execute(
        select(ApiKey).where(ApiKey.project_id == project_id)
    )
    keys: list[ApiKey] = list(result.scalars().all())
    return keys


async def create_scoped_key(
    project_id: uuid.UUID,
    name: str,
    permissions: dict[str, Any],
    session: AsyncSession,
) -> dict[str, str | dict[str, Any]]:
    """Create a scoped API key with table-level permissions.

    Returns the full key info (one-time display). Key is stored as a hash.
    """
    full_key = generate_api_key("scoped")
    key_hash = hash_api_key(full_key)
    key_prefix = full_key[:8]

    api_key = ApiKey(
        id=uuid.uuid4(),
        project_id=project_id,
        key_hash=key_hash,
        key_prefix=key_prefix,
        role="scoped",
        name=name,
        permissions=permissions,
    )
    session.add(api_key)
    return {
        "id": str(api_key.id),
        "role": "scoped",
        "name": name,
        "key": full_key,
        "key_prefix": key_prefix,
        "permissions": permissions,
    }


async def delete_project_key(
    project_id: uuid.UUID,
    key_id: uuid.UUID,
    session: AsyncSession,
) -> bool:
    """Delete a specific API key from a project.

    Returns True if a key was deleted, False if not found.
    """
    result = await session.execute(
        delete(ApiKey).where(
            ApiKey.project_id == project_id,
            ApiKey.id == key_id,
        )
    )
    return bool(result.rowcount)  # type: ignore[attr-defined]


async def rotate_project_keys(
    project_id: uuid.UUID, session: AsyncSession
) -> list[dict[str, str]]:
    """Rotate all keys for a project: delete old, create new.

    Returns the new full keys (one-time display).
    """
    await session.execute(delete(ApiKey).where(ApiKey.project_id == project_id))
    return await create_project_keys(project_id, session)
