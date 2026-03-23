"""Add wrapped_encryption_key column to projects table.

Revision ID: 007
Revises: 006
Create Date: 2026-03-22
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("wrapped_encryption_key", sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "wrapped_encryption_key")
