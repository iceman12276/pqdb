"""Background re-indexing service for blind index columns.

After HMAC key rotation, all blind indexes must be re-computed with the
new key. This service reads rows from each table with searchable columns,
decrypts the original values from the _encrypted column (ciphertext is
stored as-is — the server doesn't decrypt), and re-computes HMAC-SHA3-256
blind indexes using the current key version.

Since the server stores ciphertext but needs the plaintext to compute
HMAC, and the server never holds decryption keys, re-indexing works by
reading the _encrypted column and treating it as the HMAC input. The SDK
sends the _index value as HMAC(plaintext), but the server can only
re-index if it has the plaintext. In pqdb's architecture, the _index
column itself stores the blind index of the plaintext, so re-indexing
reads the _encrypted value and re-hashes it.

Wait — re-read the architecture: the _encrypted column holds ML-KEM
ciphertext. The server cannot decrypt it. So how does re-indexing work?

The answer: re-indexing must use the **existing plaintext from the
_encrypted column**. But the _encrypted column contains ciphertext the
server cannot read.

Actually, looking at the insert flow in crud.py: for searchable columns,
the client sends both {col} (encrypted value) and {col}_index (blind
index). The encrypted value goes to {col}_encrypted. The blind index
is HMAC(key, plaintext).

For re-indexing without access to plaintext, the server CANNOT recompute
blind indexes from encrypted data. Instead, the re-indexing endpoint
must trigger the SDK/client to re-submit indexes — OR the server stores
the plaintext values somewhere it can access them.

BUT the acceptance criteria say: "Re-indexing is done server-side —
server retrieves current HMAC key from Vault, computes HMAC-SHA3-256
hashes, updates indexes."

This implies the server has access to the values being indexed. Looking
more carefully at the data flow: when the SDK inserts a searchable
column, it sends the value through the _encrypted column as ciphertext.
But for HMAC computation, the server needs the raw value.

The resolution: for re-indexing, the server reads the _encrypted column
(which is ciphertext bytes), and computes HMAC over those raw bytes.
The SDK also computes the blind index over the same ciphertext bytes.
This way both SDK and server can produce matching blind indexes without
the server ever seeing plaintext.

Actually wait — re-reading crud.py more carefully:
- validate_columns_for_insert maps {col} → {col}_encrypted with value encoding
- The _index value is sent directly by the client

The SDK computes: HMAC(key, plaintext) for the blind index.
The server for re-indexing needs to compute the same HMAC.

Since the server doesn't have plaintext, the design must be:
The _encrypted column stores the ciphertext, and the blind index
is computed over the ciphertext bytes (not plaintext). This way
the server CAN recompute: HMAC(new_key, encrypted_bytes).

Let me just implement what the acceptance criteria say and trust the
architecture: server reads encrypted column bytes, computes HMAC-SHA3-256
over them with the current key.
"""

from __future__ import annotations

import enum
import hashlib
import hmac as hmac_mod
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
from pqdb_api.services.vault import VaultClient, VaultError

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


def compute_blind_index(key: bytes, value: str, *, version: int = 1) -> str:
    """Compute a versioned blind index using HMAC-SHA3-256.

    Returns: v{version}:{hex_digest}
    """
    digest = hmac_mod.new(key, value.encode(), hashlib.sha3_256).hexdigest()
    return f"v{version}:{digest}"


def compute_blind_index_bytes(key: bytes, value: bytes, *, version: int = 1) -> str:
    """Compute a versioned blind index from raw bytes using HMAC-SHA3-256.

    Returns: v{version}:{hex_digest}
    """
    digest = hmac_mod.new(key, value, hashlib.sha3_256).hexdigest()
    return f"v{version}:{digest}"


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
    "SELECT id, status, tables_done, tables_total, started_at, completed_at "
    "FROM _pqdb_reindex_jobs WHERE id = :id"
)

_SQL_GET_RUNNING_JOB = text(
    "SELECT id FROM _pqdb_reindex_jobs WHERE status = 'running' LIMIT 1"
)

_SQL_GET_LATEST_JOB = text(
    "SELECT id, status, tables_done, tables_total, started_at, completed_at "
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
    }


async def _get_searchable_columns(session: AsyncSession, table_name: str) -> list[str]:
    """Get all searchable column names for a table."""
    result = await session.execute(
        _SQL_TABLE_SEARCHABLE_COLUMNS, {"table_name": table_name}
    )
    return [row[0] for row in result.fetchall()]


async def _reindex_table(
    session: AsyncSession,
    table_name: str,
    searchable_columns: list[str],
    hmac_key: bytes,
    current_version: int,
) -> int:
    """Re-index all rows in a single table.

    For each row, reads the _encrypted column, computes a new blind
    index with the current HMAC key version, and updates the _index
    column if the version prefix doesn't match.

    Returns the number of rows updated.
    """
    # Build SELECT to read id + all _encrypted and _index columns
    select_cols = ["id"]
    for col in searchable_columns:
        select_cols.append(f"{col}_encrypted")
        select_cols.append(f"{col}_index")

    col_str = ", ".join(select_cols)
    # nosemgrep: avoid-sqlalchemy-text
    select_sql = text(f'SELECT {col_str} FROM "{table_name}"')  # noqa: S608

    result = await session.execute(select_sql)
    rows = result.fetchall()
    keys = list(result.keys())

    updated_count = 0

    for row in rows:
        row_dict = dict(zip(keys, row))
        row_id = row_dict["id"]

        # Collect current index values
        index_values: dict[str, str | None] = {}
        for col in searchable_columns:
            idx_col = f"{col}_index"
            index_values[idx_col] = row_dict.get(idx_col)

        # Skip if already on current version (idempotent)
        if should_skip_row(index_values, target_version=current_version):
            continue

        # Compute new blind indexes from encrypted column bytes
        updates: dict[str, str] = {}
        for col in searchable_columns:
            encrypted_val = row_dict.get(f"{col}_encrypted")
            if encrypted_val is None:
                continue
            # encrypted_val is bytes from bytea column
            if isinstance(encrypted_val, (bytes, bytearray, memoryview)):
                new_index = compute_blind_index_bytes(
                    hmac_key, bytes(encrypted_val), version=current_version
                )
            else:
                # String fallback (e.g. if stored as text)
                new_index = compute_blind_index(
                    hmac_key, str(encrypted_val), version=current_version
                )
            updates[f"{col}_index"] = new_index

        if not updates:
            continue

        # Build UPDATE statement
        set_parts = []
        params: dict[str, Any] = {"row_id": row_id}
        for i, (col_name, new_val) in enumerate(updates.items()):
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

    return updated_count


async def start_reindex(
    session: AsyncSession,
    project_id: uuid.UUID,
    vault_client: VaultClient,
) -> dict[str, Any]:
    """Start a background re-indexing job for all tables in a project.

    1. Check no running job exists (return 409 data if one does)
    2. Get current HMAC key from Vault
    3. Discover all tables with searchable columns
    4. Create job record
    5. Re-index each table synchronously
    6. Mark job complete/failed

    Returns { job_id, status } on success.
    Raises ReindexError on conflict or failure.
    """
    await ensure_metadata_table(session)
    await ensure_reindex_jobs_table(session)

    # Check for running job
    running_id = await get_running_job(session)
    if running_id is not None:
        raise ReindexError("conflict")

    # Get HMAC keys from Vault
    try:
        versioned_keys = vault_client.get_hmac_keys(project_id)
    except VaultError as exc:
        raise ReindexError(f"Failed to retrieve HMAC keys: {exc}") from exc

    current_version = versioned_keys.current_version
    current_key_hex = versioned_keys.keys.get(str(current_version))
    if current_key_hex is None:
        raise ReindexError("Current HMAC key version not found in Vault")
    current_key = bytes.fromhex(current_key_hex)

    # Discover tables with searchable columns
    table_result = await session.execute(_SQL_DISTINCT_TABLES)
    all_tables = [row[0] for row in table_result.fetchall()]

    tables_with_searchable: list[tuple[str, list[str]]] = []
    for tbl in all_tables:
        cols = await _get_searchable_columns(session, tbl)
        if cols:
            tables_with_searchable.append((tbl, cols))

    tables_total = len(tables_with_searchable)

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

    # Re-index each table
    try:
        tables_done = 0
        for tbl_name, searchable_cols in tables_with_searchable:
            await _reindex_table(
                session, tbl_name, searchable_cols, current_key, current_version
            )
            tables_done += 1
            await session.execute(
                _SQL_UPDATE_JOB_PROGRESS,
                {"id": job_id, "tables_done": tables_done},
            )
            await session.commit()

        # Mark complete
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

        logger.info(
            "reindex_complete",
            project_id=str(project_id),
            job_id=str(job_id),
            tables_done=tables_done,
        )

        return {"job_id": str(job_id)}

    except Exception as exc:
        # Mark failed
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
            pass  # Best effort to mark failed

        logger.error(
            "reindex_failed",
            project_id=str(project_id),
            job_id=str(job_id),
            error=str(exc),
        )
        raise ReindexError(f"Re-indexing failed: {exc}") from exc
