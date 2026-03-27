"""Unit tests for the branching service."""

import uuid

from pqdb_api.services.branching import (
    BranchingError,
    BranchLimitExceededError,
    InvalidBranchNameError,
    make_branch_database_name,
)


class TestBranchStatusConstants:
    """Verify branch status values used for race-condition guards."""

    def test_active_status(self) -> None:
        from pqdb_api.services.branching import BRANCH_STATUS_ACTIVE

        assert BRANCH_STATUS_ACTIVE == "active"

    def test_merging_status(self) -> None:
        from pqdb_api.services.branching import BRANCH_STATUS_MERGING

        assert BRANCH_STATUS_MERGING == "merging"

    def test_rebasing_status(self) -> None:
        from pqdb_api.services.branching import BRANCH_STATUS_REBASING

        assert BRANCH_STATUS_REBASING == "rebasing"


class TestInvalidBranchNameError:
    """Tests for the InvalidBranchNameError exception."""

    def test_is_branching_error(self) -> None:
        err = InvalidBranchNameError("bad name")
        assert isinstance(err, BranchingError)

    def test_message(self) -> None:
        err = InvalidBranchNameError("bad name")
        assert str(err) == "bad name"


class TestMakeBranchDatabaseName:
    """Tests for branch database name generation."""

    def test_format_prefix(self) -> None:
        branch_id = uuid.uuid4()
        name = make_branch_database_name(branch_id)
        assert name.startswith("pqdb_branch_")

    def test_uses_first_12_hex_chars(self) -> None:
        branch_id = uuid.uuid4()
        name = make_branch_database_name(branch_id)
        expected = f"pqdb_branch_{branch_id.hex[:12]}"
        assert name == expected

    def test_deterministic(self) -> None:
        branch_id = uuid.uuid4()
        assert make_branch_database_name(branch_id) == make_branch_database_name(
            branch_id
        )

    def test_different_ids_produce_different_names(self) -> None:
        a = make_branch_database_name(uuid.uuid4())
        b = make_branch_database_name(uuid.uuid4())
        assert a != b


class TestBranchLimitExceededError:
    """Tests for the BranchLimitExceededError exception."""

    def test_is_branching_error(self) -> None:
        err = BranchLimitExceededError("too many")
        assert isinstance(err, BranchingError)

    def test_message(self) -> None:
        err = BranchLimitExceededError("limit reached")
        assert str(err) == "limit reached"
