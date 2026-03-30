"""Pure rule evaluation functions for the Security Advisor (US-102).

Each function takes pre-fetched metadata and returns a list of Finding
objects. No database or I/O access — makes them trivial to unit-test.
"""

from __future__ import annotations

import dataclasses
from typing import Any


@dataclasses.dataclass(frozen=True)
class Finding:
    """A single security advisor finding."""

    rule_id: str
    severity: str  # "warning" | "info"
    category: str
    title: str
    message: str
    table: str | None
    suggestion: str | None


# PII-suggesting column name keywords (case-insensitive substring match).
_PII_KEYWORDS = frozenset(
    {"email", "phone", "ssn", "password", "secret", "token", "address"}
)

# Column names that indicate row-level ownership.
_OWNER_COLUMN_NAMES = frozenset(
    {"owner", "owner_id", "user_id", "created_by", "author_id"}
)


def check_missing_rls(
    tables: list[str],
    tables_with_policies: set[str],
) -> list[Finding]:
    """Rule: tables with no RLS policies -> severity 'warning'."""
    findings: list[Finding] = []
    for table in tables:
        if table not in tables_with_policies:
            findings.append(
                Finding(
                    rule_id="no-rls",
                    severity="warning",
                    category="access-control",
                    title="No RLS policies on table",
                    message=f"Table '{table}' has no row-level security policies.",
                    table=table,
                    suggestion="Enable RLS and add policies to restrict row access.",
                )
            )
    return findings


def check_plain_pii_columns(
    columns: list[dict[str, Any]],
) -> list[Finding]:
    """Rule: plain columns with PII-suggesting names -> severity 'warning'."""
    findings: list[Finding] = []
    for col in columns:
        if col["sensitivity"] != "plain":
            continue
        col_name_lower = col["column_name"].lower()
        for keyword in _PII_KEYWORDS:
            if keyword in col_name_lower:
                findings.append(
                    Finding(
                        rule_id="plain-pii",
                        severity="warning",
                        category="data-protection",
                        title="Potentially sensitive column stored in plain text",
                        message=(
                            f"Column '{col['column_name']}' on table "
                            f"'{col['table_name']}' may contain PII."
                        ),
                        table=col["table_name"],
                        suggestion=(
                            f"Consider changing '{col['column_name']}' sensitivity "
                            f"to 'searchable' or 'private'."
                        ),
                    )
                )
                break  # One finding per column
    return findings


def check_delete_permissions(
    api_keys: list[dict[str, Any]],
) -> list[Finding]:
    """Rule: scoped keys with delete permission -> severity 'info'."""
    findings: list[Finding] = []
    for key in api_keys:
        if key["role"] != "scoped":
            continue
        permissions = key.get("permissions")
        if permissions is None:
            continue
        tables = permissions.get("tables", {})
        has_delete = any("delete" in ops for ops in tables.values())
        if has_delete:
            key_name = key.get("name", "unnamed")
            findings.append(
                Finding(
                    rule_id="scoped-delete",
                    severity="info",
                    category="access-control",
                    title="Scoped key has delete permission",
                    message=(
                        f"Scoped API key '{key_name}' has delete permission. "
                        f"Review whether this is intended."
                    ),
                    table=None,
                    suggestion="Remove delete permission if not required.",
                )
            )
    return findings


def check_missing_owner_column(
    tables: list[str],
    columns: list[dict[str, Any]],
) -> list[Finding]:
    """Rule: no owner column on any table -> severity 'info'."""
    # Build a set of tables that have an owner-like column
    tables_with_owner: set[str] = set()
    for col in columns:
        if col["column_name"].lower() in _OWNER_COLUMN_NAMES:
            tables_with_owner.add(col["table_name"])

    findings: list[Finding] = []
    for table in tables:
        if table not in tables_with_owner:
            findings.append(
                Finding(
                    rule_id="no-owner",
                    severity="info",
                    category="access-control",
                    title="No owner column on table",
                    message=(
                        f"Table '{table}' has no owner/user_id column "
                        f"for row-level ownership."
                    ),
                    table=table,
                    suggestion=(
                        "Add an 'owner_id' or 'user_id' column to enable "
                        "row-level ownership filtering."
                    ),
                )
            )
    return findings


def check_missing_indexes(
    table_stats: list[dict[str, Any]],
) -> list[Finding]:
    """Rule: tables with no indexes beyond PK and row count > 1000."""
    findings: list[Finding] = []
    for stat in table_stats:
        row_count = stat["row_count"]
        index_count = stat["index_count"]
        if row_count > 1000 and index_count <= 1:
            findings.append(
                Finding(
                    rule_id="no-indexes",
                    severity="info",
                    category="performance",
                    title="Large table with no additional indexes",
                    message=(
                        f"Table '{stat['table_name']}' has {row_count} rows "
                        f"but only {index_count} index(es)."
                    ),
                    table=stat["table_name"],
                    suggestion="Add indexes on frequently queried columns.",
                )
            )
    return findings
