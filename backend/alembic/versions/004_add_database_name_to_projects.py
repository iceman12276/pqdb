"""Add database_name column to projects table.

Revision ID: 004
Revises: 003
Create Date: 2026-03-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("database_name", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "database_name")
