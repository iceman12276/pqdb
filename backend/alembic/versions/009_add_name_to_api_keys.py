"""Add name column to api_keys table for scoped keys.

Revision ID: 009
Revises: 008
Create Date: 2026-03-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "009"
down_revision: str | None = "008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "api_keys",
        sa.Column("name", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("api_keys", "name")
