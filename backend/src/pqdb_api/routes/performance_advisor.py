"""Performance advisor endpoint (US-103).

Queries pg_stat_user_tables and pg_stat_user_indexes to collect
database performance statistics, then evaluates them against
rule functions to produce actionable recommendations.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import get_project_session
from pqdb_api.services.performance_rules import (
    evaluate_dead_tuples,
    evaluate_missing_indexes,
    evaluate_stale_stats,
    evaluate_unused_indexes,
)

router = APIRouter(prefix="/v1/db/advisor", tags=["advisor"])

_TABLE_STATS_SQL = text("""
    SELECT
        s.relname,
        s.n_live_tup,
        s.n_dead_tup,
        s.seq_scan,
        s.idx_scan,
        s.last_analyze,
        (
            SELECT COUNT(*)
            FROM pg_catalog.pg_indexes i
            WHERE i.tablename = s.relname
              AND i.schemaname = 'public'
              AND i.indexname NOT IN (
                  SELECT ci.relname
                  FROM pg_catalog.pg_constraint con
                  JOIN pg_catalog.pg_class ci ON ci.oid = con.conindid
                  WHERE con.conrelid = c.oid
              )
        ) AS user_index_count
    FROM pg_catalog.pg_stat_user_tables s
    JOIN pg_catalog.pg_class c ON c.relname = s.relname
        AND c.relnamespace = (
            SELECT oid FROM pg_catalog.pg_namespace
            WHERE nspname = 'public'
        )
    WHERE s.schemaname = 'public'
      AND s.relname NOT LIKE '_pqdb_%'
    ORDER BY s.relname
""")

_INDEX_STATS_SQL = text("""
    SELECT
        s.indexrelname,
        s.relname,
        s.idx_scan,
        s.idx_tup_read,
        s.idx_tup_fetch
    FROM pg_catalog.pg_stat_user_indexes s
    WHERE s.schemaname = 'public'
      AND s.relname NOT LIKE '_pqdb_%'
      AND s.indexrelname NOT IN (
          SELECT ci.relname
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class ci ON ci.oid = con.conindid
          JOIN pg_catalog.pg_class ct ON ct.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
          WHERE n.nspname = 'public'
      )
    ORDER BY s.relname, s.indexrelname
""")


@router.get("/performance")
async def get_performance_recommendations(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """Analyze project database performance and return recommendations.

    Queries pg_stat_user_tables and pg_stat_user_indexes, then evaluates
    the statistics against performance rules.
    """
    # Fetch table statistics
    table_result = await session.execute(_TABLE_STATS_SQL)
    table_stats = [
        {
            "relname": row[0],
            "n_live_tup": row[1] or 0,
            "n_dead_tup": row[2] or 0,
            "seq_scan": row[3] or 0,
            "idx_scan": row[4] or 0,
            "last_analyze": row[5],
            "user_index_count": row[6] or 0,
        }
        for row in table_result.fetchall()
    ]

    # Fetch index statistics
    index_result = await session.execute(_INDEX_STATS_SQL)
    index_stats = [
        {
            "indexrelname": row[0],
            "relname": row[1],
            "idx_scan": row[2] or 0,
            "idx_tup_read": row[3] or 0,
            "idx_tup_fetch": row[4] or 0,
        }
        for row in index_result.fetchall()
    ]

    # Evaluate all rules
    recommendations: list[dict[str, Any]] = []
    recommendations.extend(evaluate_missing_indexes(table_stats))
    recommendations.extend(evaluate_unused_indexes(index_stats))
    recommendations.extend(evaluate_dead_tuples(table_stats))
    recommendations.extend(evaluate_stale_stats(table_stats))

    return recommendations
