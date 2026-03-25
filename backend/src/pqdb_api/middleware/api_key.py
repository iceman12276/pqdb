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
from pqdb_api.services.auth import InvalidTokenError, TokenExpiredError, decode_token

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
        raise PermissionError(f"API key is not allowed to access table '{table_name}'")

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


async def _resolve_via_api_key(
    raw_key: str,
    platform_session: AsyncSession,
) -> tuple[uuid.UUID, str, dict[str, Any] | None]:
    """Resolve project_id, role, and permissions from an API key.

    Returns (project_id, role, permissions).
    Raises HTTPException on invalid key.
    """
    try:
        prefix, _role = _parse_api_key(raw_key)
    except ValueError:
        raise HTTPException(status_code=403, detail="Invalid API key")

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

    return matched_key.project_id, matched_key.role, matched_key.permissions


async def _resolve_via_developer_jwt(
    request: Request,
    platform_session: AsyncSession,
) -> tuple[uuid.UUID, str, dict[str, Any] | None]:
    """Resolve project context from a developer JWT + x-project-id header.

    The developer JWT proves identity. The x-project-id header specifies
    which project to access. We verify the developer owns the project.

    Returns (project_id, "service", None) — developer gets service-level access.
    Raises HTTPException on invalid token or unauthorized project.
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authentication")

    token = auth_header[7:]
    public_key = getattr(request.app.state, "mldsa65_public_key", None)
    if not public_key:
        raise HTTPException(status_code=500, detail="Server signing key not configured")

    try:
        payload = decode_token(token, public_key)
    except TokenExpiredError:
        raise HTTPException(status_code=401, detail="Token expired")
    except InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")

    developer_id = payload.get("sub")
    if not developer_id:
        raise HTTPException(status_code=401, detail="Invalid token: missing sub")

    # Require x-project-id header
    project_id_str = request.headers.get("x-project-id")
    if not project_id_str:
        raise HTTPException(status_code=400, detail="Missing x-project-id header")

    try:
        project_id = uuid.UUID(project_id_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid x-project-id")

    # Verify the developer owns this project
    proj_result = await platform_session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == uuid.UUID(developer_id),
        )
    )
    project = proj_result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=403, detail="Project not found or not owned by you")

    # Developer gets service-level access with no scoped restrictions
    return project_id, "service", None


async def get_project_context(
    request: Request,
    platform_session: AsyncSession = Depends(get_session),
) -> ProjectContext:
    """FastAPI dependency: resolve project context from apikey or developer JWT.

    Two auth methods supported:
    1. ``apikey`` header — for SDK/app traffic (existing flow)
    2. ``Authorization: Bearer`` + ``x-project-id`` — for developer tools (MCP server)

    Returns a ``ProjectContext`` with project_id, key_role, and database_name.
    """
    raw_key = request.headers.get("apikey")

    if raw_key:
        # Path 1: API key auth (SDK, dashboard, apps)
        project_id, role, permissions = await _resolve_via_api_key(
            raw_key, platform_session
        )
    elif request.headers.get("authorization", "").startswith("Bearer "):
        # Path 2: Developer JWT auth (MCP server, dev tools)
        project_id, role, permissions = await _resolve_via_developer_jwt(
            request, platform_session
        )
    else:
        raise HTTPException(status_code=401, detail="Missing apikey or Authorization header")

    # Load project to get database_name
    proj_result = await platform_session.execute(
        select(Project).where(Project.id == project_id)
    )
    project = proj_result.scalar_one_or_none()
    if project is None or project.database_name is None:
        raise HTTPException(status_code=403, detail="Project not provisioned")

    ctx = ProjectContext(
        project_id=project_id,
        key_role=role,
        database_name=project.database_name,
        permissions=permissions,
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
