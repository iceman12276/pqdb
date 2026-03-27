"""Unit tests for the DatabaseBranch model and branch name validation."""

import uuid
from typing import cast

from sqlalchemy import String, Table

from pqdb_api.models.branch import DatabaseBranch, validate_branch_name


class TestValidateBranchName:
    """Tests for branch name validation function."""

    def test_valid_simple_name(self) -> None:
        assert validate_branch_name("feature") is True

    def test_valid_with_hyphens(self) -> None:
        assert validate_branch_name("my-feature") is True

    def test_valid_with_underscores(self) -> None:
        assert validate_branch_name("my_feature") is True

    def test_valid_with_numbers(self) -> None:
        assert validate_branch_name("feature123") is True

    def test_valid_mixed(self) -> None:
        assert validate_branch_name("a0-b_c") is True

    def test_valid_single_char(self) -> None:
        assert validate_branch_name("a") is True

    def test_valid_max_length_63(self) -> None:
        name = "a" * 63
        assert validate_branch_name(name) is True

    def test_rejects_empty_string(self) -> None:
        assert validate_branch_name("") is False

    def test_rejects_starts_with_number(self) -> None:
        assert validate_branch_name("1feature") is False

    def test_rejects_starts_with_hyphen(self) -> None:
        assert validate_branch_name("-feature") is False

    def test_rejects_starts_with_underscore(self) -> None:
        assert validate_branch_name("_feature") is False

    def test_rejects_uppercase(self) -> None:
        assert validate_branch_name("Feature") is False

    def test_rejects_spaces(self) -> None:
        assert validate_branch_name("my feature") is False

    def test_rejects_dots(self) -> None:
        assert validate_branch_name("my.feature") is False

    def test_rejects_slashes(self) -> None:
        assert validate_branch_name("my/feature") is False

    def test_rejects_too_long_64_chars(self) -> None:
        name = "a" * 64
        assert validate_branch_name(name) is False

    def test_rejects_reserved_main(self) -> None:
        assert validate_branch_name("main") is False

    def test_rejects_reserved_master(self) -> None:
        assert validate_branch_name("master") is False

    def test_rejects_reserved_prod(self) -> None:
        assert validate_branch_name("prod") is False

    def test_rejects_reserved_production(self) -> None:
        assert validate_branch_name("production") is False


class TestDatabaseBranchModel:
    """Tests for DatabaseBranch SQLAlchemy model."""

    def test_table_name(self) -> None:
        assert DatabaseBranch.__tablename__ == "database_branches"

    def test_columns_exist(self) -> None:
        columns = {c.name for c in DatabaseBranch.__table__.columns}
        expected = {
            "id",
            "project_id",
            "name",
            "database_name",
            "parent_database",
            "status",
            "created_at",
        }
        assert columns == expected

    def test_id_is_primary_key(self) -> None:
        pk_cols = [c.name for c in DatabaseBranch.__table__.primary_key]
        assert pk_cols == ["id"]

    def test_project_id_is_foreign_key(self) -> None:
        col = DatabaseBranch.__table__.columns["project_id"]
        fk_targets = [fk.target_fullname for fk in col.foreign_keys]
        assert "projects.id" in fk_targets

    def test_database_name_is_unique(self) -> None:
        col = DatabaseBranch.__table__.columns["database_name"]
        assert col.unique is True

    def test_status_defaults_to_active(self) -> None:
        branch = DatabaseBranch(
            id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            name="dev",
            database_name="pqdb_branch_abc",
            parent_database="pqdb_project_abc",
        )
        assert branch.status == "active"

    def test_can_instantiate_with_valid_data(self) -> None:
        branch_id = uuid.uuid4()
        project_id = uuid.uuid4()
        branch = DatabaseBranch(
            id=branch_id,
            project_id=project_id,
            name="feature-x",
            database_name="pqdb_branch_feature_x",
            parent_database="pqdb_project_main",
            status="active",
        )
        assert branch.id == branch_id
        assert branch.project_id == project_id
        assert branch.name == "feature-x"
        assert branch.database_name == "pqdb_branch_feature_x"
        assert branch.parent_database == "pqdb_project_main"
        assert branch.status == "active"

    def test_unique_constraint_on_project_id_and_name(self) -> None:
        """Verify unique constraint exists on (project_id, name)."""
        table = cast(Table, DatabaseBranch.__table__)
        unique_constraints = [
            c
            for c in table.constraints
            if hasattr(c, "columns")
            and {col.name for col in c.columns} == {"project_id", "name"}
        ]
        assert len(unique_constraints) == 1

    def test_index_on_project_id(self) -> None:
        """Verify index exists on project_id for fast listing."""
        table = cast(Table, DatabaseBranch.__table__)
        project_id_indexes = [
            idx
            for idx in table.indexes
            if any(col.name == "project_id" for col in idx.columns)
        ]
        assert len(project_id_indexes) >= 1

    def test_name_max_length(self) -> None:
        col = DatabaseBranch.__table__.columns["name"]
        assert isinstance(col.type, String)
        assert col.type.length == 63

    def test_database_name_max_length(self) -> None:
        col = DatabaseBranch.__table__.columns["database_name"]
        assert isinstance(col.type, String)
        assert col.type.length == 255

    def test_parent_database_max_length(self) -> None:
        col = DatabaseBranch.__table__.columns["parent_database"]
        assert isinstance(col.type, String)
        assert col.type.length == 255

    def test_name_is_not_nullable(self) -> None:
        col = DatabaseBranch.__table__.columns["name"]
        assert col.nullable is False

    def test_project_id_is_not_nullable(self) -> None:
        col = DatabaseBranch.__table__.columns["project_id"]
        assert col.nullable is False

    def test_database_name_is_not_nullable(self) -> None:
        col = DatabaseBranch.__table__.columns["database_name"]
        assert col.nullable is False

    def test_parent_database_is_not_nullable(self) -> None:
        col = DatabaseBranch.__table__.columns["parent_database"]
        assert col.nullable is False
