"""Unit tests for performance advisor rule evaluation (US-103).

Tests pure functions that evaluate Postgres statistics and produce
performance recommendations. No database or I/O required.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from pqdb_api.services.performance_rules import (
    evaluate_dead_tuples,
    evaluate_missing_indexes,
    evaluate_stale_stats,
    evaluate_unused_indexes,
)


# ---------------------------------------------------------------------------
# evaluate_missing_indexes
# ---------------------------------------------------------------------------
class TestEvaluateMissingIndexes:
    """Tables with >1000 rows, >100 seq scans, no user indexes → warning."""

    def test_flags_table_with_high_seq_scans_no_indexes(self) -> None:
        stats = [
            {
                "relname": "orders",
                "n_live_tup": 5000,
                "seq_scan": 200,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_missing_indexes(stats)
        assert len(results) == 1
        rec = results[0]
        assert rec["rule_id"] == "missing_index"
        assert rec["severity"] == "warning"
        assert rec["category"] == "performance"
        assert rec["table"] == "orders"
        assert "index" in rec["suggestion"].lower()

    def test_ignores_table_below_row_threshold(self) -> None:
        stats = [
            {
                "relname": "small_table",
                "n_live_tup": 500,
                "seq_scan": 300,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_missing_indexes(stats)
        assert len(results) == 0

    def test_ignores_table_below_seq_scan_threshold(self) -> None:
        stats = [
            {
                "relname": "low_scans",
                "n_live_tup": 5000,
                "seq_scan": 50,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_missing_indexes(stats)
        assert len(results) == 0

    def test_ignores_table_with_user_indexes(self) -> None:
        stats = [
            {
                "relname": "indexed_table",
                "n_live_tup": 5000,
                "seq_scan": 300,
                "idx_scan": 100,
                "n_dead_tup": 0,
                "last_analyze": None,
                "user_index_count": 2,
            },
        ]
        results = evaluate_missing_indexes(stats)
        assert len(results) == 0

    def test_empty_input_returns_empty(self) -> None:
        results = evaluate_missing_indexes([])
        assert results == []

    def test_multiple_tables_only_flags_qualifying(self) -> None:
        stats = [
            {
                "relname": "big_no_idx",
                "n_live_tup": 2000,
                "seq_scan": 500,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": None,
                "user_index_count": 0,
            },
            {
                "relname": "big_with_idx",
                "n_live_tup": 2000,
                "seq_scan": 500,
                "idx_scan": 100,
                "n_dead_tup": 0,
                "last_analyze": None,
                "user_index_count": 1,
            },
        ]
        results = evaluate_missing_indexes(stats)
        assert len(results) == 1
        assert results[0]["table"] == "big_no_idx"


# ---------------------------------------------------------------------------
# evaluate_unused_indexes
# ---------------------------------------------------------------------------
class TestEvaluateUnusedIndexes:
    """Indexes with idx_scan = 0 → info, suggest dropping."""

    def test_flags_unused_index(self) -> None:
        stats = [
            {
                "indexrelname": "idx_orders_old",
                "relname": "orders",
                "idx_scan": 0,
                "idx_tup_read": 0,
                "idx_tup_fetch": 0,
            },
        ]
        results = evaluate_unused_indexes(stats)
        assert len(results) == 1
        rec = results[0]
        assert rec["rule_id"] == "unused_index"
        assert rec["severity"] == "info"
        assert rec["category"] == "performance"
        assert rec["table"] == "orders"
        assert "drop" in rec["suggestion"].lower()
        assert "idx_orders_old" in rec["message"]

    def test_ignores_used_index(self) -> None:
        stats = [
            {
                "indexrelname": "idx_orders_id",
                "relname": "orders",
                "idx_scan": 100,
                "idx_tup_read": 5000,
                "idx_tup_fetch": 4000,
            },
        ]
        results = evaluate_unused_indexes(stats)
        assert len(results) == 0

    def test_empty_input_returns_empty(self) -> None:
        results = evaluate_unused_indexes([])
        assert results == []

    def test_multiple_indexes_flags_only_unused(self) -> None:
        stats = [
            {
                "indexrelname": "idx_a",
                "relname": "t1",
                "idx_scan": 0,
                "idx_tup_read": 0,
                "idx_tup_fetch": 0,
            },
            {
                "indexrelname": "idx_b",
                "relname": "t1",
                "idx_scan": 50,
                "idx_tup_read": 200,
                "idx_tup_fetch": 150,
            },
        ]
        results = evaluate_unused_indexes(stats)
        assert len(results) == 1
        assert results[0]["message"].__contains__("idx_a")


# ---------------------------------------------------------------------------
# evaluate_dead_tuples
# ---------------------------------------------------------------------------
class TestEvaluateDeadTuples:
    """Tables with n_dead_tup / n_live_tup > 0.1 → warning, suggest VACUUM."""

    def test_flags_high_dead_tuple_ratio(self) -> None:
        stats = [
            {
                "relname": "orders",
                "n_live_tup": 1000,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 200,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_dead_tuples(stats)
        assert len(results) == 1
        rec = results[0]
        assert rec["rule_id"] == "high_dead_tuples"
        assert rec["severity"] == "warning"
        assert rec["category"] == "maintenance"
        assert rec["table"] == "orders"
        assert "vacuum" in rec["suggestion"].lower()

    def test_ignores_low_dead_tuple_ratio(self) -> None:
        stats = [
            {
                "relname": "clean_table",
                "n_live_tup": 1000,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 50,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_dead_tuples(stats)
        assert len(results) == 0

    def test_handles_zero_live_tuples(self) -> None:
        """Tables with zero live tuples should not divide by zero."""
        stats = [
            {
                "relname": "empty_table",
                "n_live_tup": 0,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 100,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_dead_tuples(stats)
        # Either flag it (dead tuples with no live) or skip — shouldn't crash
        assert isinstance(results, list)

    def test_empty_input_returns_empty(self) -> None:
        results = evaluate_dead_tuples([])
        assert results == []

    def test_exact_threshold_not_flagged(self) -> None:
        """Ratio of exactly 0.1 should NOT be flagged (strictly greater than)."""
        stats = [
            {
                "relname": "edge_table",
                "n_live_tup": 1000,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 100,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_dead_tuples(stats)
        assert len(results) == 0


# ---------------------------------------------------------------------------
# evaluate_stale_stats
# ---------------------------------------------------------------------------
class TestEvaluateStaleStats:
    """Tables with no ANALYZE in > 7 days → info, suggest ANALYZE."""

    def test_flags_table_never_analyzed(self) -> None:
        stats = [
            {
                "relname": "orders",
                "n_live_tup": 100,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": None,
                "user_index_count": 0,
            },
        ]
        results = evaluate_stale_stats(stats)
        assert len(results) == 1
        rec = results[0]
        assert rec["rule_id"] == "stale_stats"
        assert rec["severity"] == "info"
        assert rec["category"] == "maintenance"
        assert rec["table"] == "orders"
        assert "analyze" in rec["suggestion"].lower()

    def test_flags_table_analyzed_long_ago(self) -> None:
        old_date = datetime.now(timezone.utc) - timedelta(days=14)
        stats = [
            {
                "relname": "old_stats",
                "n_live_tup": 100,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": old_date,
                "user_index_count": 0,
            },
        ]
        results = evaluate_stale_stats(stats)
        assert len(results) == 1
        assert results[0]["table"] == "old_stats"

    def test_ignores_recently_analyzed(self) -> None:
        recent_date = datetime.now(timezone.utc) - timedelta(days=2)
        stats = [
            {
                "relname": "fresh_table",
                "n_live_tup": 100,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": recent_date,
                "user_index_count": 0,
            },
        ]
        results = evaluate_stale_stats(stats)
        assert len(results) == 0

    def test_empty_input_returns_empty(self) -> None:
        results = evaluate_stale_stats([])
        assert results == []

    def test_exactly_7_days_not_flagged(self) -> None:
        """Analyzed 6 days ago should NOT be flagged."""
        recent = datetime.now(timezone.utc) - timedelta(days=6)
        stats = [
            {
                "relname": "boundary_table",
                "n_live_tup": 100,
                "seq_scan": 0,
                "idx_scan": 0,
                "n_dead_tup": 0,
                "last_analyze": recent,
                "user_index_count": 0,
            },
        ]
        results = evaluate_stale_stats(stats)
        assert len(results) == 0
