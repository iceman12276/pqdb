"""Audit logging middleware.

Records API request metadata to the project-scoped _pqdb_audit_log table.
Only logs requests that have a resolved project context (i.e., requests
with a valid apikey header targeting /v1/db/* endpoints).
"""

from __future__ import annotations

import uuid
from typing import Any

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
)

from pqdb_api.middleware.api_key import _build_project_database_url, _get_or_create_engine
from pqdb_api.services.audit_log import (
    classify_event_type,
    ensure_audit_table,
    write_audit_log,
)

logger = structlog.get_logger()

# Paths that should not be audit-logged (health checks, etc.)
_SKIP_PATHS = {"/health", "/ready", "/v1/db/health"}


class AuditMiddleware(BaseHTTPMiddleware):
    """Middleware that writes audit log entries for project-scoped requests."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        """Process the request and log it if it has a project context."""
        response = await call_next(request)

        # Only log project-scoped requests (those with apikey header)
        raw_key = request.headers.get("apikey")
        if not raw_key:
            return response

        path = request.url.path
        if path in _SKIP_PATHS:
            return response

        # Extract project context from request state if available
        project_id: uuid.UUID | None = getattr(
            request.state, "audit_project_id", None
        )
        database_name: str | None = getattr(
            request.state, "audit_database_name", None
        )

        if project_id is None or database_name is None:
            return response

        user_id: uuid.UUID | None = getattr(
            request.state, "audit_user_id", None
        )

        # Get client IP
        ip_address = request.client.host if request.client else "unknown"

        event_type = classify_event_type(path)

        # Write audit log in background — don't block the response
        try:
            session = await self._get_project_session(request, database_name)
            try:
                await ensure_audit_table(session)
                await write_audit_log(
                    session,
                    event_type=event_type,
                    method=request.method,
                    path=path,
                    status_code=response.status_code,
                    project_id=project_id,
                    user_id=user_id,
                    ip_address=ip_address,
                )
            finally:
                await session.close()
        except Exception:
            logger.warning(
                "audit_log_write_failed",
                project_id=str(project_id),
                path=path,
                exc_info=True,
            )

        return response

    async def _get_project_session(
        self, request: Request, database_name: str
    ) -> AsyncSession:
        """Create a session connected to the project's database for audit logging."""
        test_factory: Any = getattr(
            request.app.state, "_test_audit_session_factory", None
        )
        if test_factory is not None:
            session: AsyncSession = test_factory()
            return session

        settings = request.app.state.settings
        project_db_url = _build_project_database_url(
            settings.database_url, database_name
        )
        engine = _get_or_create_engine(
            request.app.state, project_db_url, database_name
        )
        factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        return factory()
