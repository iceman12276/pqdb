"""Unit tests for the re-indexing service."""

from __future__ import annotations

import hashlib
import hmac
import uuid

from pqdb_api.services.reindex import (
    ReindexJob,
    ReindexStatus,
    compute_blind_index,
    parse_version_prefix,
    should_skip_row,
)


class TestComputeBlindIndex:
    """Tests for HMAC-SHA3-256 blind index computation."""

    def test_compute_blind_index_deterministic(self) -> None:
        key = bytes.fromhex("ab" * 32)
        value = "test@example.com"
        result1 = compute_blind_index(key, value)
        result2 = compute_blind_index(key, value)
        assert result1 == result2

    def test_compute_blind_index_format(self) -> None:
        """Result should be v{version}:{hex_digest}."""
        key = bytes.fromhex("ab" * 32)
        value = "hello"
        result = compute_blind_index(key, value, version=2)
        assert result.startswith("v2:")
        # After prefix, should be valid hex
        hex_part = result.split(":", 1)[1]
        bytes.fromhex(hex_part)  # will raise if not valid hex

    def test_compute_blind_index_matches_python_hmac(self) -> None:
        """Must match Python's hmac + hashlib.sha3_256."""
        key = bytes.fromhex("ab" * 32)
        value = "test@example.com"
        expected = hmac.new(key, value.encode(), hashlib.sha3_256).hexdigest()
        result = compute_blind_index(key, value, version=1)
        assert result == f"v1:{expected}"

    def test_different_keys_produce_different_indexes(self) -> None:
        key1 = bytes.fromhex("ab" * 32)
        key2 = bytes.fromhex("cd" * 32)
        value = "same_value"
        idx1 = compute_blind_index(key1, value, version=1)
        idx2 = compute_blind_index(key2, value, version=1)
        assert idx1 != idx2


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
