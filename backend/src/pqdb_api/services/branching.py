"""Database branching service.

Creates branch databases using CREATE DATABASE ... TEMPLATE,
enforces per-project branch limits, and handles cleanup.
"""

from __future__ import annotations

import uuid
from typing import Any

import asyncpg
import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.models.branch import DatabaseBranch
from pqdb_api.services.provisioner import _validate_identifier

logger = structlog.get_logger()

MAX_BRANCHES_PER_PROJECT = 5

# Branch status constants for race-condition guards
BRANCH_STATUS_ACTIVE = "active"
BRANCH_STATUS_MERGING = "merging"
BRANCH_STATUS_REBASING = "rebasing"


class BranchingError(Exception):
    """Raised when branch operations fail."""


class BranchLimitExceededError(BranchingError):
    """Raised when the branch limit per project is exceeded."""


class InvalidBranchNameError(BranchingError):
    """Raised when a branch name fails validation."""


def make_branch_database_name(branch_id: uuid.UUID) -> str:
    """Generate a database name from a branch UUID.

    Format: pqdb_branch_{first 12 hex chars of uuid}
    """
    return f"pqdb_branch_{branch_id.hex[:12]}"


def _build_create_template_sql(branch_db: str, template_db: str) -> str:
    """Build CREATE DATABASE ... TEMPLATE with validated identifiers.

    PostgreSQL DDL does not support parameterized queries. Identifiers
    are generated from UUIDs and validated against a strict allowlist.
    """
    _validate_identifier(branch_db)
    _validate_identifier(template_db)
    return "CREATE DATABASE " + branch_db + " TEMPLATE " + template_db  # noqa: S608


def _build_grant_branch_sql(branch_db: str, user: str) -> str:
    """Build GRANT CONNECT for a branch database with validated identifiers."""
    _validate_identifier(branch_db)
    _validate_identifier(user)
    return "GRANT CONNECT ON DATABASE " + branch_db + " TO " + user  # noqa: S608


def _build_drop_database_sql(branch_db: str) -> str:
    """Build DROP DATABASE IF EXISTS with validated identifier."""
    _validate_identifier(branch_db)
    return "DROP DATABASE IF EXISTS " + branch_db  # noqa: S608


async def check_branch_limit(
    session: AsyncSession,
    project_id: uuid.UUID,
) -> int:
    """Return active branch count for a project.

    Raises BranchLimitExceededError if at the limit.
    """
    result = await session.execute(
        select(func.count())
        .select_from(DatabaseBranch)
        .where(
            DatabaseBranch.project_id == project_id,
        )
    )
    count: int = result.scalar_one()
    if count >= MAX_BRANCHES_PER_PROJECT:
        raise BranchLimitExceededError(
            f"Maximum {MAX_BRANCHES_PER_PROJECT} branches per project"
        )
    return count


async def create_branch_database(
    superuser_dsn: str,
    branch_db_name: str,
    template_db_name: str,
    project_user: str,
) -> None:
    """Create a branch database from a template using superuser connection.

    1. Terminates active connections to the template database
       (required by CREATE DATABASE ... TEMPLATE).
    2. Creates the branch database.
    3. Grants CONNECT to the project user.
    """
    conn: Any = None
    try:
        conn = await asyncpg.connect(superuser_dsn)

        # Terminate active connections to the template DB
        await conn.execute(
            "SELECT pg_terminate_backend(pid) "
            "FROM pg_stat_activity "
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
            template_db_name,
        )

        # CREATE DATABASE ... TEMPLATE (DDL cannot be parameterized)
        await conn.execute(_build_create_template_sql(branch_db_name, template_db_name))

        # Grant connect to project user
        await conn.execute(_build_grant_branch_sql(branch_db_name, project_user))

        logger.info(
            "branch_database_created",
            branch_db=branch_db_name,
            template_db=template_db_name,
        )
    except Exception as exc:
        logger.error(
            "branch_database_creation_failed",
            branch_db=branch_db_name,
            template_db=template_db_name,
            error=str(exc),
        )
        raise BranchingError(str(exc)) from exc
    finally:
        if conn is not None:
            await conn.close()


async def get_active_connection_count(
    superuser_dsn: str,
    database_name: str,
) -> int:
    """Return the number of active connections to a database."""
    conn: Any = None
    try:
        conn = await asyncpg.connect(superuser_dsn)
        row = await conn.fetchrow(
            "SELECT count(*) AS cnt FROM pg_stat_activity "
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
            database_name,
        )
        return int(row["cnt"]) if row else 0
    except Exception as exc:
        logger.error(
            "get_connection_count_failed",
            database_name=database_name,
            error=str(exc),
        )
        raise BranchingError(str(exc)) from exc
    finally:
        if conn is not None:
            await conn.close()


async def drop_branch_database(
    superuser_dsn: str,
    branch_db_name: str,
) -> None:
    """Drop a branch database.

    Terminates active connections first, then drops the database.
    """
    conn: Any = None
    try:
        conn = await asyncpg.connect(superuser_dsn)

        # Terminate active connections
        await conn.execute(
            "SELECT pg_terminate_backend(pid) "
            "FROM pg_stat_activity "
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
            branch_db_name,
        )

        await conn.execute(_build_drop_database_sql(branch_db_name))

        logger.info("branch_database_dropped", branch_db=branch_db_name)
    except Exception as exc:
        logger.error(
            "branch_database_drop_failed",
            branch_db=branch_db_name,
            error=str(exc),
        )
        raise BranchingError(str(exc)) from exc
    finally:
        if conn is not None:
            await conn.close()
