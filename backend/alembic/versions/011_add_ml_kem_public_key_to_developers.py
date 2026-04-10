"""Add ml_kem_public_key column to developers.

Revision ID: 011
Revises: 010
Create Date: 2026-04-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "011"
down_revision: str | None = "010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "developers",
        sa.Column("ml_kem_public_key", sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("developers", "ml_kem_public_key")
