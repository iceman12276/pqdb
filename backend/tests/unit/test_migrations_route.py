"""Unit tests for migration route file parsing logic."""

from pathlib import Path
from textwrap import dedent

from pqdb_api.routes.migrations import (
    MigrationEntry,
    _parse_migration_file,
    list_migration_files,
)


class TestParseMigrationFile:
    """Verify parsing of Alembic migration files."""

    def test_parses_first_migration(self, tmp_path: Path) -> None:
        content = dedent('''\
            """Create developers table.

            Revision ID: 001
            Revises:
            Create Date: 2026-03-13
            """

            from collections.abc import Sequence

            import sqlalchemy as sa
            from alembic import op

            revision: str = "001"
            down_revision: str | None = None
            branch_labels: str | Sequence[str] | None = None
            depends_on: str | Sequence[str] | None = None

            def upgrade() -> None:
                pass

            def downgrade() -> None:
                pass
        ''')
        f = tmp_path / "001_create_developers_table.py"
        f.write_text(content)

        entry = _parse_migration_file(f)
        assert entry is not None
        assert entry.revision == "001"
        assert entry.down_revision is None
        assert entry.description == "Create developers table."
        assert entry.applied is False

    def test_parses_subsequent_migration(self, tmp_path: Path) -> None:
        content = dedent('''\
            """Add database_name to projects.

            Revision ID: 004
            Revises: 003
            Create Date: 2026-03-14
            """

            revision: str = "004"
            down_revision: str | None = "003"

            def upgrade() -> None:
                pass

            def downgrade() -> None:
                pass
        ''')
        f = tmp_path / "004_add_database_name.py"
        f.write_text(content)

        entry = _parse_migration_file(f)
        assert entry is not None
        assert entry.revision == "004"
        assert entry.down_revision == "003"
        assert entry.description == "Add database_name to projects."

    def test_returns_none_for_missing_revision(self, tmp_path: Path) -> None:
        content = "# no revision here\n"
        f = tmp_path / "bad.py"
        f.write_text(content)

        assert _parse_migration_file(f) is None

    def test_returns_none_for_nonexistent_file(self, tmp_path: Path) -> None:
        f = tmp_path / "does_not_exist.py"
        assert _parse_migration_file(f) is None


class TestListMigrationFiles:
    """Verify listing and sorting of migration files."""

    def test_lists_sorted_migrations(self, tmp_path: Path) -> None:
        for i, desc in [(1, "First"), (2, "Second"), (3, "Third")]:
            content = dedent(f'''\
                """{desc} migration.

                Revision ID: 00{i}
                """

                revision: str = "00{i}"
                down_revision: str | None = {"None" if i == 1 else f'"00{i - 1}"'}
            ''')
            f = tmp_path / f"00{i}_migration.py"
            f.write_text(content)

        entries = list_migration_files(tmp_path)
        assert len(entries) == 3
        assert entries[0].revision == "001"
        assert entries[1].revision == "002"
        assert entries[2].revision == "003"
        assert entries[0].description == "First migration."

    def test_empty_directory(self, tmp_path: Path) -> None:
        entries = list_migration_files(tmp_path)
        assert entries == []

    def test_nonexistent_directory(self, tmp_path: Path) -> None:
        entries = list_migration_files(tmp_path / "nope")
        assert entries == []

    def test_skips_init_files(self, tmp_path: Path) -> None:
        (tmp_path / "__init__.py").write_text("")
        content = dedent('''\
            """Real migration.

            Revision ID: 001
            """

            revision: str = "001"
            down_revision: str | None = None
        ''')
        (tmp_path / "001_real.py").write_text(content)

        entries = list_migration_files(tmp_path)
        assert len(entries) == 1
        assert entries[0].revision == "001"


class TestListMigrationFilesWithRealAlembic:
    """Verify listing works against the real Alembic versions directory."""

    def test_reads_real_migration_files(self) -> None:
        real_dir = Path(__file__).resolve().parents[2] / "alembic" / "versions"
        if not real_dir.is_dir():
            return  # Skip if no alembic dir (CI without full checkout)

        entries = list_migration_files(real_dir)
        assert len(entries) >= 1
        # First entry should be revision 001
        assert entries[0].revision == "001"
        assert entries[0].down_revision is None

        # All entries should have non-empty descriptions
        for entry in entries:
            assert entry.revision
            assert entry.description


class TestMigrationEntryModel:
    """Verify the Pydantic model shape."""

    def test_with_down_revision(self) -> None:
        entry = MigrationEntry(
            revision="002",
            down_revision="001",
            description="Add projects table",
            applied=True,
        )
        assert entry.revision == "002"
        assert entry.down_revision == "001"
        assert entry.applied is True

    def test_without_down_revision(self) -> None:
        entry = MigrationEntry(
            revision="001",
            down_revision=None,
            description="Initial migration",
            applied=False,
        )
        assert entry.down_revision is None
