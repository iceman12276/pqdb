"""Unit tests for the re-indexing service."""

from __future__ import annotations

import uuid

from pqdb_api.services.reindex import (
    ReindexJob,
    ReindexStatus,
    parse_version_prefix,
    should_skip_row,
)


class TestParseVersionPrefix:
    """Tests for parsing version prefix from blind index values."""

    def test_parse_versioned_index(self) -> None:
        version = parse_version_prefix("v2:abcdef1234")
        assert version == 2

    def test_parse_version_1(self) -> None:
        assert parse_version_prefix("v1:deadbeef") == 1

    def test_unversioned_returns_none(self) -> None:
        """Indexes without version prefix (legacy) return None."""
        assert parse_version_prefix("abcdef1234567890") is None

    def test_empty_string_returns_none(self) -> None:
        assert parse_version_prefix("") is None

    def test_none_value_returns_none(self) -> None:
        assert parse_version_prefix(None) is None


class TestShouldSkipRow:
    """Tests for idempotent re-indexing — skip rows already on current version."""

    def test_skip_row_already_on_current_version(self) -> None:
        index_values = {"email_index": "v3:abcdef"}
        assert should_skip_row(index_values, target_version=3) is True

    def test_do_not_skip_row_on_old_version(self) -> None:
        index_values = {"email_index": "v1:abcdef"}
        assert should_skip_row(index_values, target_version=3) is False

    def test_do_not_skip_row_with_unversioned_index(self) -> None:
        """Legacy indexes without version prefix should be re-indexed."""
        index_values = {"email_index": "abcdef1234"}
        assert should_skip_row(index_values, target_version=1) is False

    def test_skip_when_all_indexes_current(self) -> None:
        index_values = {
            "email_index": "v2:aaa",
            "phone_index": "v2:bbb",
        }
        assert should_skip_row(index_values, target_version=2) is True

    def test_do_not_skip_when_any_index_is_old(self) -> None:
        index_values = {
            "email_index": "v2:aaa",
            "phone_index": "v1:bbb",
        }
        assert should_skip_row(index_values, target_version=2) is False

    def test_empty_index_values_should_skip(self) -> None:
        """No index columns to update means nothing to do."""
        assert should_skip_row({}, target_version=2) is True


class TestReindexJob:
    """Tests for the ReindexJob dataclass."""

    def test_job_initial_state(self) -> None:
        job = ReindexJob(
            id=uuid.uuid4(),
            status=ReindexStatus.RUNNING,
            tables_done=0,
            tables_total=5,
        )
        assert job.status == ReindexStatus.RUNNING
        assert job.tables_done == 0
        assert job.tables_total == 5
        assert job.started_at is not None
        assert job.completed_at is None

    def test_status_values(self) -> None:
        assert ReindexStatus.RUNNING.value == "running"
        assert ReindexStatus.COMPLETE.value == "complete"
        assert ReindexStatus.FAILED.value == "failed"
