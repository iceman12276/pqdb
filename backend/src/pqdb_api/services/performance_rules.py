"""Pure functions for evaluating performance advisor rules.

Each rule function takes raw statistics data from Postgres system
catalogs and returns a list of recommendation dicts. Functions are
pure (no I/O) so they can be unit-tested independently.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

_ROW_THRESHOLD = 1000
_SEQ_SCAN_THRESHOLD = 100
_DEAD_TUPLE_RATIO_THRESHOLD = 0.1
_STALE_STATS_DAYS = 7


def evaluate_missing_indexes(
    table_stats: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rule: tables with >1000 rows and >100 sequential scans but no user indexes.

    Returns severity "warning" recommendations.
    """
    results: list[dict[str, Any]] = []
    for row in table_stats:
        n_live = row.get("n_live_tup", 0) or 0
        seq_scan = row.get("seq_scan", 0) or 0
        user_idx = row.get("user_index_count", 0) or 0
        table_name = row["relname"]

        if n_live > _ROW_THRESHOLD and seq_scan > _SEQ_SCAN_THRESHOLD and user_idx == 0:
            results.append(
                {
                    "rule_id": "missing_index",
                    "severity": "warning",
                    "category": "performance",
                    "title": "Missing index on frequently scanned table",
                    "message": (
                        f"Table '{table_name}' has {n_live} rows and "
                        f"{seq_scan} sequential scans but no user-defined indexes."
                    ),
                    "table": table_name,
                    "suggestion": (
                        f"Consider adding an index to '{table_name}' on "
                        f"frequently queried columns to reduce sequential scans."
                    ),
                }
            )
    return results


def evaluate_unused_indexes(
    index_stats: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rule: indexes that exist but have never been used (idx_scan = 0).

    Returns severity "info" recommendations suggesting dropping the index.
    """
    results: list[dict[str, Any]] = []
    for row in index_stats:
        idx_scan = row.get("idx_scan", 0) or 0
        index_name = row["indexrelname"]
        table_name = row["relname"]

        if idx_scan == 0:
            results.append(
                {
                    "rule_id": "unused_index",
                    "severity": "info",
                    "category": "performance",
                    "title": "Unused index",
                    "message": (
                        f"Index '{index_name}' on table '{table_name}' "
                        f"has never been used (0 index scans)."
                    ),
                    "table": table_name,
                    "suggestion": (
                        f"Consider dropping unused index '{index_name}' "
                        f"to save storage and reduce write overhead."
                    ),
                }
            )
    return results


def evaluate_dead_tuples(
    table_stats: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rule: tables with high dead tuple ratio (n_dead_tup / n_live_tup > 0.1).

    Returns severity "warning" recommendations suggesting VACUUM.
    """
    results: list[dict[str, Any]] = []
    for row in table_stats:
        n_live = row.get("n_live_tup", 0) or 0
        n_dead = row.get("n_dead_tup", 0) or 0
        table_name = row["relname"]

        if n_live == 0:
            continue

        ratio = n_dead / n_live
        if ratio > _DEAD_TUPLE_RATIO_THRESHOLD:
            results.append(
                {
                    "rule_id": "high_dead_tuples",
                    "severity": "warning",
                    "category": "maintenance",
                    "title": "High dead tuple ratio",
                    "message": (
                        f"Table '{table_name}' has {n_dead} dead tuples "
                        f"vs {n_live} live tuples (ratio: {ratio:.2f})."
                    ),
                    "table": table_name,
                    "suggestion": (
                        f"Run VACUUM ANALYZE on '{table_name}' to reclaim "
                        f"space and update planner statistics."
                    ),
                }
            )
    return results


def evaluate_stale_stats(
    table_stats: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rule: tables with no ANALYZE in > 7 days.

    Returns severity "info" recommendations suggesting running ANALYZE.
    """
    results: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    threshold = now - timedelta(days=_STALE_STATS_DAYS)

    for row in table_stats:
        last_analyze = row.get("last_analyze")
        table_name = row["relname"]

        if last_analyze is None or last_analyze < threshold:
            results.append(
                {
                    "rule_id": "stale_stats",
                    "severity": "info",
                    "category": "maintenance",
                    "title": "Stale table statistics",
                    "message": (
                        f"Table '{table_name}' has not been analyzed in over 7 days."
                        if last_analyze is not None
                        else f"Table '{table_name}' has never been analyzed."
                    ),
                    "table": table_name,
                    "suggestion": (
                        f"Run ANALYZE on '{table_name}' to update query "
                        f"planner statistics for better performance."
                    ),
                }
            )
    return results
