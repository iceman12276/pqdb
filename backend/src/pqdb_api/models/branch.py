"""DatabaseBranch model for tracking branch metadata."""

import re
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from pqdb_api.models.base import Base

_DEFAULT_STATUS = "active"
_BRANCH_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")
_RESERVED_NAMES = frozenset({"main", "master", "prod", "production"})


def validate_branch_name(name: str) -> bool:
    """Validate a branch name against naming rules.

    Rules:
    - Must match ^[a-z][a-z0-9_-]{0,62}$
    - Must not be a reserved name (main, master, prod, production)
    """
    if name in _RESERVED_NAMES:
        return False
    return bool(_BRANCH_NAME_PATTERN.match(name))


class DatabaseBranch(Base):
    """A branch of a project's database."""

    __tablename__ = "database_branches"
    __table_args__ = (
        UniqueConstraint("project_id", "name"),
        Index("ix_database_branches_project_id", "project_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(63), nullable=False)
    database_name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    parent_database: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __init__(self, **kwargs: object) -> None:
        if "status" not in kwargs:
            kwargs["status"] = _DEFAULT_STATUS
        super().__init__(**kwargs)
