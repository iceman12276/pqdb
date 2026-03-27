"""Unit tests for branch route validation logic."""

import uuid

from pqdb_api.models.branch import validate_branch_name
from pqdb_api.services.branching import make_branch_database_name


class TestBranchNameValidationInRoutes:
    """Verify branch name validation catches invalid inputs."""

    def test_rejects_reserved_main(self) -> None:
        assert validate_branch_name("main") is False

    def test_rejects_uppercase(self) -> None:
        assert validate_branch_name("Staging") is False

    def test_rejects_spaces(self) -> None:
        assert validate_branch_name("my branch") is False

    def test_accepts_valid_name(self) -> None:
        assert validate_branch_name("staging") is True

    def test_accepts_hyphenated(self) -> None:
        assert validate_branch_name("feature-x") is True


class TestBranchDatabaseNameFormat:
    """Verify branch database naming convention."""

    def test_format(self) -> None:
        bid = uuid.UUID("12345678-1234-1234-1234-123456789abc")
        name = make_branch_database_name(bid)
        assert name == "pqdb_branch_123456781234"

    def test_length_consistent(self) -> None:
        name = make_branch_database_name(uuid.uuid4())
        # "pqdb_branch_" (12) + 12 hex chars = 24
        assert len(name) == 24
