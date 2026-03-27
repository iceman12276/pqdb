"""Create database_branches table for branch metadata.

Revision ID: 010
Revises: 009
Create Date: 2026-03-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "010"
down_revision: str | None = "009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "database_branches",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "project_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id"),
            nullable=False,
        ),
        sa.Column("name", sa.String(63), nullable=False),
        sa.Column("database_name", sa.String(255), nullable=False, unique=True),
        sa.Column("parent_database", sa.String(255), nullable=False),
        sa.Column("status", sa.String(50), nullable=False, server_default="active"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_unique_constraint(
        "uq_database_branches_project_id_name",
        "database_branches",
        ["project_id", "name"],
    )
    op.create_index(
        "ix_database_branches_project_id",
        "database_branches",
        ["project_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_database_branches_project_id", table_name="database_branches")
    op.drop_constraint(
        "uq_database_branches_project_id_name", "database_branches", type_="unique"
    )
    op.drop_table("database_branches")
