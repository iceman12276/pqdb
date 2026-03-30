"""Security Advisor endpoint (US-102).

Analyzes a project's security posture and returns findings.
Uses get_project_session (API key required) for project-scoped
catalog queries and the platform session for API key metadata.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.database import get_session
from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.models.api_key import ApiKey
from pqdb_api.services.security_rules import (
    Finding,
    check_delete_permissions,
    check_missing_indexes,
    check_missing_owner_column,
    check_missing_rls,
    check_plain_pii_columns,
)

router = APIRouter(prefix="/v1/db/advisor", tags=["advisor"])

# --- SQL constants (static, no user input interpolated) ---

_TABLES_SQL = text("SELECT DISTINCT table_name FROM _pqdb_columns ORDER BY table_name")

_COLUMNS_SQL = text(
    "SELECT table_name, column_name, sensitivity FROM _pqdb_columns"
    " ORDER BY table_name, column_name"
)

_POLICIES_SQL = text("""
    SELECT DISTINCT c.relname AS table_name
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
""")

_TABLE_STATS_SQL = text("""
    SELECT
        c.relname AS table_name,
        c.reltuples::bigint AS row_count,
        (SELECT COUNT(*)
         FROM pg_catalog.pg_index i
         WHERE i.indrelid = c.oid) AS index_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT LIKE '_pqdb_%'
    ORDER BY c.relname
""")


def _finding_to_dict(f: Finding) -> dict[str, Any]:
    return {
        "rule_id": f.rule_id,
        "severity": f.severity,
        "category": f.category,
        "title": f.title,
        "message": f.message,
        "table": f.table,
        "suggestion": f.suggestion,
    }


@router.get("/security")
async def get_security_findings(
    request: Request,
    context: ProjectContext = Depends(get_project_context),
    project_session: AsyncSession = Depends(get_project_session),
    platform_session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """Analyze project security posture and return findings."""
    # 1. Fetch tables and columns from _pqdb_columns.
    # The table may not exist if no user tables have been created yet.
    tables: list[str] = []
    columns: list[dict[str, Any]] = []
    try:
        tables_result = await project_session.execute(_TABLES_SQL)
        tables = [row[0] for row in tables_result.fetchall()]

        cols_result = await project_session.execute(_COLUMNS_SQL)
        columns = [
            {
                "table_name": row[0],
                "column_name": row[1],
                "sensitivity": row[2],
            }
            for row in cols_result.fetchall()
        ]
    except ProgrammingError:
        await project_session.rollback()

    # 2. Fetch tables with RLS policies from pg_policy (always exists)
    policies_result = await project_session.execute(_POLICIES_SQL)
    tables_with_policies = {row[0] for row in policies_result.fetchall()}

    # 3. Fetch table stats (row counts, index counts) from pg_class
    stats_result = await project_session.execute(_TABLE_STATS_SQL)
    table_stats = [
        {
            "table_name": row[0],
            "row_count": row[1],
            "index_count": row[2],
        }
        for row in stats_result.fetchall()
    ]

    # 5. Fetch scoped API keys from platform DB
    keys_result = await platform_session.execute(
        select(ApiKey).where(
            ApiKey.project_id == context.project_id,
            ApiKey.role == "scoped",
        )
    )
    api_keys = [
        {
            "role": key.role,
            "name": key.name or "unnamed",
            "permissions": key.permissions,
        }
        for key in keys_result.scalars().all()
    ]

    # 6. Evaluate all rules
    findings: list[Finding] = []
    findings.extend(check_missing_rls(tables, tables_with_policies))
    findings.extend(check_plain_pii_columns(columns))
    findings.extend(check_delete_permissions(api_keys))
    findings.extend(check_missing_owner_column(tables, columns))
    findings.extend(check_missing_indexes(table_stats))

    return [_finding_to_dict(f) for f in findings]
