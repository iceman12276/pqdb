"""Audit log service for project-scoped request logging.

Manages the _pqdb_audit_log table within each project database,
recording API request metadata for monitoring and debugging.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

CREATE_AUDIT_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS _pqdb_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    project_id UUID NOT NULL,
    user_id UUID,
    ip_address TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""

CREATE_AUDIT_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
ON _pqdb_audit_log (created_at DESC)
"""

# Static SQL for counting audit logs with all optional filters.
# Filters use "CAST(param AS type) IS NULL OR col = param" pattern
# so no dynamic SQL construction is needed. The explicit CASTs
# resolve asyncpg's AmbiguousParameterError for NULL values.
_COUNT_SQL = text(
    "SELECT COUNT(*) FROM _pqdb_audit_log "
    "WHERE (CAST(:event_type AS TEXT) IS NULL OR event_type = :event_type) "
    "AND (CAST(:status_code AS INTEGER) IS NULL OR status_code = :status_code) "
    "AND (CAST(:start_time AS TIMESTAMPTZ) IS NULL OR created_at >= :start_time) "
    "AND (CAST(:end_time AS TIMESTAMPTZ) IS NULL OR created_at <= :end_time)"
)

_SELECT_SQL = text(
    "SELECT id, event_type, method, path, status_code, project_id, "
    "user_id, ip_address, created_at "
    "FROM _pqdb_audit_log "
    "WHERE (CAST(:event_type AS TEXT) IS NULL OR event_type = :event_type) "
    "AND (CAST(:status_code AS INTEGER) IS NULL OR status_code = :status_code) "
    "AND (CAST(:start_time AS TIMESTAMPTZ) IS NULL OR created_at >= :start_time) "
    "AND (CAST(:end_time AS TIMESTAMPTZ) IS NULL OR created_at <= :end_time) "
    "ORDER BY created_at DESC LIMIT :limit OFFSET :offset"
)

_INSERT_SQL = text(
    "INSERT INTO _pqdb_audit_log "
    "(id, event_type, method, path, status_code, project_id, user_id, ip_address) "
    "VALUES (:id, :event_type, :method, :path, "
    ":status_code, :project_id, :user_id, :ip_address)"
)


async def ensure_audit_table(session: AsyncSession) -> None:
    """Create the _pqdb_audit_log table if it does not exist."""
    await session.execute(text(CREATE_AUDIT_TABLE_SQL))
    await session.execute(text(CREATE_AUDIT_INDEX_SQL))
    await session.commit()


async def write_audit_log(
    session: AsyncSession,
    *,
    event_type: str,
    method: str,
    path: str,
    status_code: int,
    project_id: uuid.UUID,
    user_id: uuid.UUID | None,
    ip_address: str,
) -> None:
    """Write a single audit log entry."""
    await session.execute(
        _INSERT_SQL,
        {
            "id": uuid.uuid4(),
            "event_type": event_type,
            "method": method,
            "path": path,
            "status_code": status_code,
            "project_id": project_id,
            "user_id": user_id,
            "ip_address": ip_address,
        },
    )
    await session.commit()


def classify_event_type(path: str) -> str:
    """Classify a request path into an event type category."""
    if "/v1/auth/" in path or "/user-auth/" in path:
        return "auth"
    if "/v1/db/" in path:
        return "database"
    return "database"


async def query_audit_logs(
    session: AsyncSession,
    *,
    limit: int = 50,
    offset: int = 0,
    event_type: str | None = None,
    status_code: int | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
) -> dict[str, Any]:
    """Query audit logs with pagination and filtering.

    Returns {"data": [...], "total": int, "limit": int, "offset": int}.
    All filters are optional; when None they are ignored via
    "param IS NULL OR col = param" pattern in the static SQL.
    """
    params: dict[str, Any] = {
        "event_type": event_type,
        "status_code": status_code,
        "start_time": start_time,
        "end_time": end_time,
        "limit": limit,
        "offset": offset,
    }

    count_result = await session.execute(_COUNT_SQL, params)
    total = count_result.scalar() or 0

    result = await session.execute(_SELECT_SQL, params)
    rows = result.fetchall()

    data = [
        {
            "id": str(row[0]),
            "event_type": row[1],
            "method": row[2],
            "path": row[3],
            "status_code": row[4],
            "project_id": str(row[5]),
            "user_id": str(row[6]) if row[6] else None,
            "ip_address": row[7],
            "created_at": row[8].isoformat() if row[8] else None,
        }
        for row in rows
    ]

    return {
        "data": data,
        "total": total,
        "limit": limit,
        "offset": offset,
    }
