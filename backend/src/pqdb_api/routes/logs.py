"""Project audit log endpoints.

Provides read-only access to audit logs for a specific project.
Requires developer JWT authentication (project owner only).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project
from pqdb_api.routes.projects import _get_project_session
from pqdb_api.services.audit_log import ensure_audit_table, query_audit_logs

router = APIRouter(prefix="/v1/projects", tags=["logs"])


class AuditLogEntry(BaseModel):
    """Single audit log entry."""

    id: str
    event_type: str
    method: str
    path: str
    status_code: int
    project_id: str
    user_id: str | None
    ip_address: str
    created_at: str | None


class AuditLogResponse(BaseModel):
    """Paginated audit log response."""

    data: list[AuditLogEntry]
    total: int
    limit: int
    offset: int


@router.get("/{project_id}/logs", response_model=AuditLogResponse)
async def get_project_logs(
    project_id: uuid.UUID,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
    limit: int = 50,
    offset: int = 0,
    event_type: str | None = None,
    status_code: int | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
) -> dict[str, Any]:
    """Get audit logs for a project with pagination and filtering.

    Requires developer JWT (project owner only).
    """
    if limit < 1 or limit > 100:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 100")
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")

    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == developer_id,
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.database_name is None:
        raise HTTPException(status_code=400, detail="Project not provisioned")

    project_session = await _get_project_session(request, project)
    try:
        await ensure_audit_table(project_session)
        logs = await query_audit_logs(
            project_session,
            limit=limit,
            offset=offset,
            event_type=event_type,
            status_code=status_code,
            start_time=start_time,
            end_time=end_time,
        )
        return logs
    finally:
        await project_session.close()
