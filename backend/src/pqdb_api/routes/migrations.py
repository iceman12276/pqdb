"""Migration history endpoint: lists Alembic migration files + applied status."""

import os
import re
import uuid
from pathlib import Path

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.project import Project

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/projects", tags=["migrations"])

# Alembic versions directory — relative to this file
_ALEMBIC_VERSIONS_DIR = Path(__file__).resolve().parents[3] / "alembic" / "versions"


class MigrationEntry(BaseModel):
    """A single migration in the history."""

    revision: str
    down_revision: str | None
    description: str
    applied: bool


class MigrationListResponse(BaseModel):
    """Response for the migrations endpoint."""

    current_head: str | None
    migrations: list[MigrationEntry]


def _parse_migration_file(filepath: Path) -> MigrationEntry | None:
    """Parse an Alembic migration file to extract revision metadata.

    Reads the top of the file for the module docstring (description),
    the ``revision`` variable, and the ``down_revision`` variable.
    """
    try:
        content = filepath.read_text()
    except OSError:
        return None

    # Extract the module docstring (first triple-quoted string)
    doc_match = re.search(r'^"""(.*?)"""', content, re.DOTALL)
    description = ""
    if doc_match:
        # First line of the docstring is the description
        description = doc_match.group(1).strip().split("\n")[0].strip()

    # Extract revision
    rev_pat = r'^revision:\s*str\s*=\s*["\'](.+?)["\']'
    rev_match = re.search(rev_pat, content, re.MULTILINE)
    if not rev_match:
        return None
    revision = rev_match.group(1)

    # Extract down_revision
    down_match = re.search(
        r"^down_revision:\s*(?:str\s*\|\s*None)\s*=\s*(.+)",
        content,
        re.MULTILINE,
    )
    down_revision: str | None = None
    if down_match:
        raw = down_match.group(1).strip()
        if raw == "None":
            down_revision = None
        else:
            # Strip quotes
            stripped = raw.strip("\"'")
            down_revision = stripped

    return MigrationEntry(
        revision=revision,
        down_revision=down_revision,
        description=description,
        applied=False,  # will be updated by the endpoint
    )


def list_migration_files(versions_dir: Path | None = None) -> list[MigrationEntry]:
    """Read all migration files from the Alembic versions directory."""
    target_dir = versions_dir or _ALEMBIC_VERSIONS_DIR
    if not target_dir.is_dir():
        return []

    entries: list[MigrationEntry] = []
    for filename in sorted(os.listdir(target_dir)):
        if not filename.endswith(".py") or filename.startswith("__"):
            continue
        filepath = target_dir / filename
        entry = _parse_migration_file(filepath)
        if entry is not None:
            entries.append(entry)

    return entries


@router.get("/{project_id}/migrations", response_model=MigrationListResponse)
async def get_migrations(
    project_id: uuid.UUID,
    developer_id: str = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> MigrationListResponse:
    """List all Alembic migrations with current applied status.

    Reads migration files from disk and queries alembic_version table
    for the currently applied revision. Requires developer JWT.
    """
    # Verify the developer owns this project
    result = await session.execute(
        select(Project).where(
            Project.id == project_id,
            Project.developer_id == uuid.UUID(developer_id),
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Get currently applied revision from alembic_version table
    current_head: str | None = None
    applied_versions: set[str] = set()
    try:
        result = await session.execute(text("SELECT version_num FROM alembic_version"))
        rows = result.fetchall()
        for row in rows:
            applied_versions.add(row[0])
        if applied_versions:
            current_head = max(applied_versions)
    except ProgrammingError:
        # alembic_version table may not exist yet
        logger.debug("alembic_version_not_found", project_id=str(project_id))

    # Parse migration files from disk
    migrations = list_migration_files()

    # Mark applied migrations
    for migration in migrations:
        if migration.revision in applied_versions:
            migration.applied = True

    return MigrationListResponse(
        current_head=current_head,
        migrations=migrations,
    )
