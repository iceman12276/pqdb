"""SDK-driven re-indexing service for blind index columns.

After HMAC key rotation, blind indexes reference the old key version.
The server cannot recompute blind indexes because it never sees plaintext
(zero-knowledge architecture). Instead, re-indexing is SDK-driven:

1. Server creates a job, discovers tables with searchable columns
2. SDK fetches rows, decrypts encrypted values, re-computes HMAC(new_key, plaintext)
3. SDK sends updated indexes back via a batch endpoint
4. Server stores the SDK-computed indexes and tracks progress

Re-indexing is idempotent: rows already on the current version are skipped.
Only one re-index job may run per project at a time (tracked in
_pqdb_reindex_jobs table).
"""

from __future__ import annotations

import enum
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.services.schema_engine import ensure_metadata_table

logger = structlog.get_logger()

_VERSION_PREFIX_RE = re.compile(r"^v(\d+):")


class ReindexStatus(enum.Enum):
    """Status of a re-index job."""

    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"


@dataclass
class ReindexJob:
    """Tracks the state of a re-indexing job."""

    id: uuid.UUID
    status: ReindexStatus
    tables_done: int
    tables_total: int
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = None


class ReindexError(Exception):
    """Raised when re-indexing fails."""


def parse_version_prefix(index_value: str | None) -> int | None:
    """Extract the version number from a versioned blind index.

    Returns None if the value is unversioned or empty.
    """
    if not index_value:
        return None
    m = _VERSION_PREFIX_RE.match(index_value)
    if m:
        return int(m.group(1))
    return None


def should_skip_row(
    index_values: Mapping[str, str | None], *, target_version: int
) -> bool:
    """Check if all index columns are already on the target version.

    Returns True if the row can be skipped (idempotent).
    """
    if not index_values:
        return True
    for value in index_values.values():
        v = parse_version_prefix(value)
        if v != target_version:
            return False
    return True


# --- SQL for _pqdb_reindex_jobs table ---

_SQL_CREATE_REINDEX_JOBS = text(
    "CREATE TABLE IF NOT EXISTS _pqdb_reindex_jobs ("
    "  id uuid PRIMARY KEY,"
    "  status text NOT NULL DEFAULT 'running',"
    "  tables_done integer NOT NULL DEFAULT 0,"
    "  tables_total integer NOT NULL DEFAULT 0,"
    "  rows_updated integer NOT NULL DEFAULT 0,"
    "  started_at timestamptz NOT NULL DEFAULT now(),"
    "  completed_at timestamptz"
    ")"
)

_SQL_INSERT_JOB = text(
    "INSERT INTO _pqdb_reindex_jobs (id, status, tables_done, tables_total) "
    "VALUES (:id, :status, :tables_done, :tables_total)"
)

_SQL_UPDATE_JOB_PROGRESS = text(
    "UPDATE _pqdb_reindex_jobs SET tables_done = :tables_done WHERE id = :id"
)

_SQL_INCREMENT_ROWS_UPDATED = text(
    "UPDATE _pqdb_reindex_jobs SET rows_updated = rows_updated + :count WHERE id = :id"
)

_SQL_UPDATE_JOB_STATUS = text(
    "UPDATE _pqdb_reindex_jobs "
    "SET status = :status, completed_at = :completed_at "
    "WHERE id = :id"
)

_SQL_UPDATE_JOB_COMPLETE = text(
    "UPDATE _pqdb_reindex_jobs "
    "SET status = :status, tables_done = :tables_done, completed_at = :completed_at "
    "WHERE id = :id"
)

_SQL_GET_JOB = text(
    "SELECT id, status, tables_done, tables_total, started_at, completed_at, "
    "COALESCE(rows_updated, 0) as rows_updated "
    "FROM _pqdb_reindex_jobs WHERE id = :id"
)

_SQL_GET_RUNNING_JOB = text(
    "SELECT id FROM _pqdb_reindex_jobs WHERE status = 'running' LIMIT 1"
)

_SQL_GET_LATEST_JOB = text(
    "SELECT id, status, tables_done, tables_total, started_at, completed_at, "
    "COALESCE(rows_updated, 0) as rows_updated "
    "FROM _pqdb_reindex_jobs ORDER BY started_at DESC LIMIT 1"
)

_SQL_DISTINCT_TABLES = text(
    "SELECT DISTINCT table_name FROM _pqdb_columns ORDER BY table_name"
)

_SQL_TABLE_SEARCHABLE_COLUMNS = text(
    "SELECT column_name FROM _pqdb_columns "
    "WHERE table_name = :table_name AND sensitivity = 'searchable' "
    "ORDER BY id"
)


async def ensure_reindex_jobs_table(session: AsyncSession) -> None:
    """Create the _pqdb_reindex_jobs table if it doesn't exist."""
    await session.execute(_SQL_CREATE_REINDEX_JOBS)
    await session.commit()


async def get_running_job(session: AsyncSession) -> uuid.UUID | None:
    """Check if there is a running re-index job. Returns job_id or None."""
    await ensure_reindex_jobs_table(session)
    result = await session.execute(_SQL_GET_RUNNING_JOB)
    row = result.fetchone()
    if row:
        val: uuid.UUID = row[0]
        return val
    return None


async def get_latest_job_status(
    session: AsyncSession,
) -> dict[str, Any] | None:
    """Get the latest re-index job status."""
    await ensure_reindex_jobs_table(session)
    result = await session.execute(_SQL_GET_LATEST_JOB)
    row = result.fetchone()
    if not row:
        return None
    return {
        "job_id": str(row[0]),
        "status": row[1],
        "tables_done": row[2],
        "tables_total": row[3],
        "started_at": row[4].isoformat() if row[4] else None,
        "completed_at": row[5].isoformat() if row[5] else None,
        "rows_updated": row[6],
    }


async def get_job_status(
    session: AsyncSession, job_id: uuid.UUID
) -> dict[str, Any] | None:
    """Get status for a specific re-index job."""
    await ensure_reindex_jobs_table(session)
    result = await session.execute(_SQL_GET_JOB, {"id": job_id})
    row = result.fetchone()
    if not row:
        return None
    return {
        "job_id": str(row[0]),
        "status": row[1],
        "tables_done": row[2],
        "tables_total": row[3],
        "started_at": row[4].isoformat() if row[4] else None,
        "completed_at": row[5].isoformat() if row[5] else None,
        "rows_updated": row[6],
    }


async def _get_searchable_columns(session: AsyncSession, table_name: str) -> list[str]:
    """Get all searchable column names for a table."""
    result = await session.execute(
        _SQL_TABLE_SEARCHABLE_COLUMNS, {"table_name": table_name}
    )
    return [row[0] for row in result.fetchall()]


async def start_reindex(
    session: AsyncSession,
    project_id: uuid.UUID,
) -> dict[str, Any]:
    """Start an SDK-driven re-indexing job for all tables in a project.

    1. Check no running job exists (raise ReindexError on conflict)
    2. Discover all tables with searchable columns
    3. Create job record
    4. Return { job_id, tables } so the SDK can drive the re-indexing

    The SDK is responsible for:
    - Fetching rows with old-version indexes
    - Decrypting encrypted values to recover plaintext
    - Re-computing HMAC(new_key, plaintext) blind indexes
    - Sending updated indexes back via apply_reindex_batch()
    - Calling complete_reindex_job() when done
    """
    await ensure_metadata_table(session)
    await ensure_reindex_jobs_table(session)

    # Check for running job
    running_id = await get_running_job(session)
    if running_id is not None:
        raise ReindexError("conflict")

    # Discover tables with searchable columns
    table_result = await session.execute(_SQL_DISTINCT_TABLES)
    all_tables = [row[0] for row in table_result.fetchall()]

    tables_info: list[dict[str, Any]] = []
    tables_total = 0
    for tbl in all_tables:
        cols = await _get_searchable_columns(session, tbl)
        if cols:
            tables_info.append({"table": tbl, "searchable_columns": cols})
            tables_total += 1

    # Create job record
    job_id = uuid.uuid4()
    await session.execute(
        _SQL_INSERT_JOB,
        {
            "id": job_id,
            "status": ReindexStatus.RUNNING.value,
            "tables_done": 0,
            "tables_total": tables_total,
        },
    )
    await session.commit()

    # If no tables to reindex, complete immediately
    if tables_total == 0:
        now = datetime.now(timezone.utc)
        await session.execute(
            _SQL_UPDATE_JOB_COMPLETE,
            {
                "id": job_id,
                "status": ReindexStatus.COMPLETE.value,
                "tables_done": 0,
                "completed_at": now,
            },
        )
        await session.commit()

    logger.info(
        "reindex_started",
        project_id=str(project_id),
        job_id=str(job_id),
        tables_total=tables_total,
    )

    return {
        "job_id": str(job_id),
        "tables": tables_info,
    }


async def apply_reindex_batch(
    session: AsyncSession,
    job_id: uuid.UUID,
    table_name: str,
    updates: list[dict[str, Any]],
) -> int:
    """Apply a batch of SDK-computed blind index updates for a table.

    Each update in the list has:
    - id: row primary key
    - indexes: { col_index: "v2:newhash", ... }

    Returns the number of rows updated.
    """
    await ensure_reindex_jobs_table(session)

    updated_count = 0

    for update in updates:
        raw_id = update["id"]
        # The id column is bigint, so cast string to int if needed
        try:
            row_id: Any = int(raw_id)
        except (ValueError, TypeError):
            row_id = raw_id  # Fallback for UUID or other types
        indexes: dict[str, str] = update["indexes"]

        if not indexes:
            continue

        # Build UPDATE statement
        set_parts = []
        params: dict[str, Any] = {"row_id": row_id}
        for i, (col_name, new_val) in enumerate(indexes.items()):
            param_key = f"v_{i}"
            set_parts.append(f"{col_name} = :{param_key}")
            params[param_key] = new_val

        set_str = ", ".join(set_parts)
        # nosemgrep: avoid-sqlalchemy-text
        update_sql = text(  # noqa: S608
            f'UPDATE "{table_name}" SET {set_str} WHERE id = :row_id'
        )
        await session.execute(update_sql, params)
        updated_count += 1

    # Increment rows_updated counter on the job
    if updated_count > 0:
        await session.execute(
            _SQL_INCREMENT_ROWS_UPDATED,
            {"id": job_id, "count": updated_count},
        )

    await session.commit()
    return updated_count


async def complete_reindex_job(
    session: AsyncSession,
    job_id: uuid.UUID,
    tables_done: int,
) -> None:
    """Mark a re-index job as complete."""
    await ensure_reindex_jobs_table(session)
    now = datetime.now(timezone.utc)
    await session.execute(
        _SQL_UPDATE_JOB_COMPLETE,
        {
            "id": job_id,
            "status": ReindexStatus.COMPLETE.value,
            "tables_done": tables_done,
            "completed_at": now,
        },
    )
    await session.commit()
    logger.info("reindex_job_completed", job_id=str(job_id), tables_done=tables_done)


async def fail_reindex_job(
    session: AsyncSession,
    job_id: uuid.UUID,
) -> None:
    """Mark a re-index job as failed."""
    await ensure_reindex_jobs_table(session)
    now = datetime.now(timezone.utc)
    try:
        await session.execute(
            _SQL_UPDATE_JOB_STATUS,
            {
                "id": job_id,
                "status": ReindexStatus.FAILED.value,
                "completed_at": now,
            },
        )
        await session.commit()
    except Exception:
        pass  # Best effort
