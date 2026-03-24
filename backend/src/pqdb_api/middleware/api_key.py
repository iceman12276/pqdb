"""API key authentication middleware (FastAPI dependency).

Reads the ``apikey`` header, validates it against stored hashes,
resolves the owning project, and provides a project-scoped database
session for downstream handlers.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.models.api_key import ApiKey
from pqdb_api.models.project import Project
from pqdb_api.services.api_keys import verify_api_key

logger = structlog.get_logger()

_API_KEY_PREFIX = "pqdb_"
_VALID_ROLES = {"anon", "service", "scoped"}


def _parse_api_key(key: str) -> tuple[str, str]:
    """Parse a raw API key and return (prefix, role).

    Expected format: ``pqdb_{role}_{random_32_chars}``

    Raises ``ValueError`` for malformed keys.
    """
    if not key.startswith(_API_KEY_PREFIX):
        raise ValueError("Invalid API key format")

    parts = key.split("_", 2)
    if len(parts) != 3 or parts[0] != "pqdb" or parts[1] not in _VALID_ROLES:
        raise ValueError("Invalid API key format")

    role = parts[1]
    prefix = key[:8]
    return prefix, role


@dataclasses.dataclass(frozen=True)
class ProjectContext:
    """Immutable context resolved from a valid API key."""

    project_id: uuid.UUID
    key_role: str
    database_name: str
    permissions: dict[str, Any] | None = None


def check_scoped_permissions(
    permissions: dict[str, Any] | None,
    table_name: str,
    operation: str,
) -> None:
    """Check if a scoped key's permissions allow a table/operation.

    Args:
        permissions: The permissions dict from the API key, or None for full access.
        table_name: The table being accessed.
        operation: The CRUD operation (select, insert, update, delete).

    Raises:
        PermissionError: If the operation is not allowed.
    """
    if permissions is None:
        return

    tables = permissions.get("tables", {})
    if table_name not in tables:
        raise PermissionError(
            f"API key is not allowed to access table '{table_name}'"
        )

    allowed_ops = tables[table_name]
    if operation not in allowed_ops:
        raise PermissionError(
            f"API key is not allowed to perform '{operation}' on table '{table_name}'"
        )


def _build_project_database_url(platform_url: str, database_name: str) -> str:
    """Build a project database URL by swapping the DB name."""
    last_slash = platform_url.rfind("/")
    if last_slash == -1:
        raise ValueError("Invalid platform database URL")
    return platform_url[: last_slash + 1] + database_name


def _get_or_create_engine(
    app_state: Any, database_url: str, database_name: str
) -> AsyncEngine:
    """Return a pooled engine for the project database, creating one if needed."""
    if not hasattr(app_state, "project_engines"):
        app_state.project_engines = {}

    engines: dict[str, AsyncEngine] = app_state.project_engines
    if database_name not in engines:
        engine = create_async_engine(
            database_url,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,
        )
        engines[database_name] = engine
        logger.info("project_engine_created", database_name=database_name)
    return engines[database_name]


async def get_project_context(
    request: Request,
    platform_session: AsyncSession = Depends(get_session),
) -> ProjectContext:
    """FastAPI dependency: validate apikey header and resolve project context.

    Returns a ``ProjectContext`` with project_id, key_role, and database_name.

    Raises:
        HTTPException 401: missing apikey header
        HTTPException 403: invalid or unrecognised key
    """
    raw_key = request.headers.get("apikey")
    if not raw_key:
        raise HTTPException(status_code=401, detail="Missing apikey header")

    try:
        prefix, _role = _parse_api_key(raw_key)
    except ValueError:
        raise HTTPException(status_code=403, detail="Invalid API key")

    # Narrow lookup by prefix — avoids iterating all keys with argon2id
    result = await platform_session.execute(
        select(ApiKey).where(ApiKey.key_prefix == prefix)
    )
    candidates = list(result.scalars().all())

    matched_key: ApiKey | None = None
    for candidate in candidates:
        if verify_api_key(candidate.key_hash, raw_key):
            matched_key = candidate
            break

    if matched_key is None:
        raise HTTPException(status_code=403, detail="Invalid API key")

    # Load project to get database_name
    proj_result = await platform_session.execute(
        select(Project).where(Project.id == matched_key.project_id)
    )
    project = proj_result.scalar_one_or_none()
    if project is None or project.database_name is None:
        raise HTTPException(status_code=403, detail="Project not provisioned")

    ctx = ProjectContext(
        project_id=matched_key.project_id,
        key_role=matched_key.role,
        database_name=project.database_name,
        permissions=matched_key.permissions,
    )

    # Store on request.state for audit middleware to pick up
    request.state.audit_project_id = ctx.project_id
    request.state.audit_database_name = ctx.database_name

    return ctx


async def get_project_session(
    request: Request,
    context: ProjectContext = Depends(get_project_context),
) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: yield a project-scoped database session.

    The engine is pooled per database_name on ``app.state``.
    """
    settings = request.app.state.settings
    project_db_url = _build_project_database_url(
        settings.database_url, context.database_name
    )
    engine = _get_or_create_engine(
        request.app.state, project_db_url, context.database_name
    )
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session
