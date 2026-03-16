"""Roles and policies service — custom roles + per-table RLS policies (US-040).

Manages _pqdb_roles and _pqdb_policies tables in project databases.
Provides CRUD operations for custom roles and table-level RLS policies.
"""

from __future__ import annotations

import enum
import uuid
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

# nosemgrep: avoid-sqlalchemy-text
_SAFE = text

_BUILT_IN_ROLES = frozenset({"authenticated", "anon"})


class PolicyOperation(enum.Enum):
    """Allowed CRUD operations for policies."""

    SELECT = "select"
    INSERT = "insert"
    UPDATE = "update"
    DELETE = "delete"


class PolicyCondition(enum.Enum):
    """Allowed RLS conditions for policies."""

    OWNER = "owner"
    ALL = "all"
    NONE = "none"


# ---------------------------------------------------------------------------
# Role CRUD
# ---------------------------------------------------------------------------


async def create_role(
    session: AsyncSession,
    name: str,
    description: str | None = None,
) -> dict[str, Any]:
    """Create a custom role. Rejects reserved role names.

    Raises ValueError if role name is reserved or already exists.
    """
    if name in _BUILT_IN_ROLES:
        raise ValueError(f"Role name {name!r} is reserved")

    # Check for existing role
    result = await session.execute(
        _SAFE("SELECT id FROM _pqdb_roles WHERE name = :name"),
        {"name": name},
    )
    if result.fetchone() is not None:
        raise ValueError(f"Role {name!r} already exists")

    role_id = str(uuid.uuid4())
    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_roles (id, name, description) "
            "VALUES (:id, :name, :description)"
        ),
        {"id": role_id, "name": name, "description": description},
    )
    await session.commit()

    logger.info("role_created", name=name)
    return {"id": role_id, "name": name, "description": description}


async def list_roles(session: AsyncSession) -> list[dict[str, Any]]:
    """List all roles (built-in + custom)."""
    result = await session.execute(
        _SAFE("SELECT id, name, description, created_at FROM _pqdb_roles ORDER BY name")
    )
    return [
        {
            "id": str(row[0]),
            "name": row[1],
            "description": row[2],
            "created_at": str(row[3]) if row[3] else None,
        }
        for row in result.fetchall()
    ]


async def delete_role(session: AsyncSession, name: str) -> None:
    """Delete a custom role and all associated policies.

    Raises ValueError if role is built-in or doesn't exist.
    """
    if name in _BUILT_IN_ROLES:
        raise ValueError(f"Cannot delete built-in role {name!r}")

    result = await session.execute(
        _SAFE("SELECT id FROM _pqdb_roles WHERE name = :name"),
        {"name": name},
    )
    if result.fetchone() is None:
        raise ValueError(f"Role {name!r} not found")

    # Delete all policies for this role first
    await session.execute(
        _SAFE("DELETE FROM _pqdb_policies WHERE role = :role"),
        {"role": name},
    )
    # Delete the role
    await session.execute(
        _SAFE("DELETE FROM _pqdb_roles WHERE name = :name"),
        {"name": name},
    )
    await session.commit()

    logger.info("role_deleted", name=name)


# ---------------------------------------------------------------------------
# Policy CRUD
# ---------------------------------------------------------------------------


async def create_policy(
    session: AsyncSession,
    *,
    table_name: str,
    name: str,
    operation: PolicyOperation,
    role: str,
    condition: PolicyCondition,
) -> dict[str, Any]:
    """Create an RLS policy for a table.

    Raises ValueError if:
    - Policy for (table, operation, role) already exists
    - Role doesn't exist in _pqdb_roles
    """
    # Validate role exists
    role_result = await session.execute(
        _SAFE("SELECT id FROM _pqdb_roles WHERE name = :name"),
        {"name": role},
    )
    if role_result.fetchone() is None:
        raise ValueError(f"Role {role!r} does not exist")

    # Check for duplicate (table_name, operation, role)
    dup_result = await session.execute(
        _SAFE(
            "SELECT id FROM _pqdb_policies "
            "WHERE table_name = :table_name AND operation = :op AND role = :role"
        ),
        {"table_name": table_name, "op": operation.value, "role": role},
    )
    if dup_result.fetchone() is not None:
        raise ValueError(
            f"Policy for ({table_name}, {operation.value}, {role}) already exists"
        )

    policy_id = str(uuid.uuid4())
    await session.execute(
        _SAFE(
            "INSERT INTO _pqdb_policies "
            "(id, table_name, name, operation, role, condition) "
            "VALUES (:id, :table_name, :name, :operation, :role, :condition)"
        ),
        {
            "id": policy_id,
            "table_name": table_name,
            "name": name,
            "operation": operation.value,
            "role": role,
            "condition": condition.value,
        },
    )
    await session.commit()

    logger.info(
        "policy_created", table=table_name, operation=operation.value, role=role
    )
    return {
        "id": policy_id,
        "table_name": table_name,
        "name": name,
        "operation": operation.value,
        "role": role,
        "condition": condition.value,
    }


async def get_policies_for_table(
    session: AsyncSession,
    table_name: str,
) -> list[dict[str, Any]]:
    """List all policies for a table."""
    result = await session.execute(
        _SAFE(
            "SELECT id, table_name, name, operation, role, condition, created_at "
            "FROM _pqdb_policies WHERE table_name = :table_name ORDER BY name"
        ),
        {"table_name": table_name},
    )
    return [
        {
            "id": str(row[0]),
            "table_name": row[1],
            "name": row[2],
            "operation": row[3],
            "role": row[4],
            "condition": row[5],
            "created_at": str(row[6]) if row[6] else None,
        }
        for row in result.fetchall()
    ]


async def delete_policy(session: AsyncSession, policy_id: str) -> None:
    """Delete a specific policy by ID.

    Raises ValueError if policy not found.
    """
    result = await session.execute(
        _SAFE("SELECT id FROM _pqdb_policies WHERE id = :id"),
        {"id": policy_id},
    )
    if result.fetchone() is None:
        raise ValueError(f"Policy {policy_id!r} not found")

    await session.execute(
        _SAFE("DELETE FROM _pqdb_policies WHERE id = :id"),
        {"id": policy_id},
    )
    await session.commit()

    logger.info("policy_deleted", policy_id=policy_id)


async def lookup_policy(
    session: AsyncSession,
    table_name: str,
    operation: str,
    role: str,
) -> dict[str, Any] | None:
    """Look up a specific policy by (table, operation, role).

    Returns the policy dict or None if not found.
    """
    result = await session.execute(
        _SAFE(
            "SELECT id, table_name, name, operation, role, condition "
            "FROM _pqdb_policies "
            "WHERE table_name = :table_name AND operation = :op AND role = :role"
        ),
        {"table_name": table_name, "op": operation, "role": role},
    )
    row = result.fetchone()
    if row is None:
        return None
    return {
        "id": str(row[0]),
        "table_name": row[1],
        "name": row[2],
        "operation": row[3],
        "role": row[4],
        "condition": row[5],
    }
