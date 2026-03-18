"""Add email_verified to developers and create developer_oauth_identities.

Revision ID: 005
Revises: 004
Create Date: 2026-03-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Add email_verified column to developers
    op.add_column(
        "developers",
        sa.Column(
            "email_verified",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    # Allow NULL password_hash for OAuth-only developers
    op.alter_column(
        "developers",
        "password_hash",
        existing_type=sa.String(255),
        nullable=True,
    )

    # Create developer_oauth_identities table
    op.create_table(
        "developer_oauth_identities",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "developer_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("developers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_uid", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            sa.dialects.postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("provider", "provider_uid"),
    )


def downgrade() -> None:
    op.drop_table("developer_oauth_identities")
    op.alter_column(
        "developers",
        "password_hash",
        existing_type=sa.String(255),
        nullable=False,
    )
    op.drop_column("developers", "email_verified")
