"""Add permissions JSONB column to api_keys table.

Revision ID: 008
Revises: 007
Create Date: 2026-03-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "008"
down_revision: str | None = "007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "api_keys",
        sa.Column("permissions", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("api_keys", "permissions")
