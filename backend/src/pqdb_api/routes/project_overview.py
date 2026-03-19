"""Project overview endpoint.

Provides project statistics (table count, request counts, etc.)
for the dashboard overview page.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project
from pqdb_api.routes.projects import _get_project_session
from pqdb_api.services.audit_log import ensure_audit_table

router = APIRouter(prefix="/v1/projects", tags=["overview"])

_COUNT_TABLES_SQL = text("SELECT COUNT(DISTINCT table_name) FROM _pqdb_columns")

_COUNT_USERS_SQL = text("SELECT COUNT(*) FROM _pqdb_users")

_COUNT_POLICIES_SQL = text("SELECT COUNT(*) FROM _pqdb_policies")

_COUNT_DB_REQUESTS_SQL = text(
    "SELECT COUNT(*) FROM _pqdb_audit_log WHERE event_type = 'database'"
)

_COUNT_AUTH_REQUESTS_SQL = text(
    "SELECT COUNT(*) FROM _pqdb_audit_log WHERE event_type = 'auth'"
)


async def _safe_count(session: AsyncSession, sql: Any) -> int:
    """Execute a count query, returning 0 if the table doesn't exist."""
    try:
        result = await session.execute(sql)
        return result.scalar() or 0
    except Exception:
        await session.rollback()
        return 0


@router.get("/{project_id}/overview")
async def get_project_overview(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Get project overview statistics for the dashboard.

    Returns status cards data: table count, user count, policy count,
    request breakdown, and connection info.
    """
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    stats: dict[str, Any] = {
        "project_id": str(project.id),
        "name": project.name,
        "status": project.status,
        "region": project.region,
        "database_name": project.database_name,
        "created_at": project.created_at.isoformat(),
        "encryption": "ML-KEM-768",
        "tables_count": 0,
        "auth_users_count": 0,
        "rls_policies_count": 0,
        "database_requests": 0,
        "auth_requests": 0,
        "realtime_requests": 0,
        "mcp_requests": 0,
    }

    if project.database_name is None:
        return stats

    project_session = await _get_project_session(request, project)
    try:
        await ensure_audit_table(project_session)

        stats["tables_count"] = await _safe_count(project_session, _COUNT_TABLES_SQL)
        stats["auth_users_count"] = await _safe_count(project_session, _COUNT_USERS_SQL)
        stats["rls_policies_count"] = await _safe_count(
            project_session, _COUNT_POLICIES_SQL
        )
        stats["database_requests"] = await _safe_count(
            project_session, _COUNT_DB_REQUESTS_SQL
        )
        stats["auth_requests"] = await _safe_count(
            project_session, _COUNT_AUTH_REQUESTS_SQL
        )
    finally:
        await project_session.close()

    return stats
