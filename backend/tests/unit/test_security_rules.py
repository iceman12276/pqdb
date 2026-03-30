"""Unit tests for security advisor rule evaluation (US-102).

Tests pure functions that evaluate security rules against
database metadata. No database or network access required.
"""

from __future__ import annotations

from typing import Any

from pqdb_api.services.security_rules import (
    Finding,
    check_delete_permissions,
    check_missing_indexes,
    check_missing_owner_column,
    check_missing_rls,
    check_plain_pii_columns,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _finding_dict(f: Finding) -> dict[str, Any]:
    return {
        "rule_id": f.rule_id,
        "severity": f.severity,
        "category": f.category,
        "title": f.title,
        "message": f.message,
        "table": f.table,
        "suggestion": f.suggestion,
    }


# ---------------------------------------------------------------------------
# Rule 1: Tables with no RLS policies
# ---------------------------------------------------------------------------
class TestCheckMissingRls:
    """check_missing_rls(tables, tables_with_policies) -> findings."""

    def test_table_without_policy_returns_warning(self) -> None:
        findings = check_missing_rls(
            tables=["users", "orders"],
            tables_with_policies={"orders"},
        )
        assert len(findings) == 1
        f = findings[0]
        assert f.rule_id == "no-rls"
        assert f.severity == "warning"
        assert f.category == "access-control"
        assert f.table == "users"
        assert "RLS" in f.title or "rls" in f.title.lower()
        assert f.suggestion is not None

    def test_all_tables_have_policies(self) -> None:
        findings = check_missing_rls(
            tables=["users", "orders"],
            tables_with_policies={"users", "orders"},
        )
        assert findings == []

    def test_no_tables_returns_empty(self) -> None:
        findings = check_missing_rls(tables=[], tables_with_policies=set())
        assert findings == []

    def test_multiple_tables_without_policies(self) -> None:
        findings = check_missing_rls(
            tables=["a", "b", "c"],
            tables_with_policies=set(),
        )
        assert len(findings) == 3
        tables = {f.table for f in findings}
        assert tables == {"a", "b", "c"}


# ---------------------------------------------------------------------------
# Rule 2: Plain columns with PII-suggesting names
# ---------------------------------------------------------------------------
class TestCheckPlainPiiColumns:
    """check_plain_pii_columns(columns_metadata) -> findings."""

    def test_plain_email_column_returns_warning(self) -> None:
        columns = [
            {"table_name": "users", "column_name": "email", "sensitivity": "plain"},
        ]
        findings = check_plain_pii_columns(columns)
        assert len(findings) == 1
        f = findings[0]
        assert f.rule_id == "plain-pii"
        assert f.severity == "warning"
        assert f.category == "data-protection"
        assert f.table == "users"
        assert "email" in f.message
        assert f.suggestion is not None

    def test_encrypted_email_returns_no_finding(self) -> None:
        columns = [
            {"table_name": "users", "column_name": "email", "sensitivity": "searchable"},
        ]
        findings = check_plain_pii_columns(columns)
        assert findings == []

    def test_private_column_returns_no_finding(self) -> None:
        columns = [
            {"table_name": "users", "column_name": "ssn", "sensitivity": "private"},
        ]
        findings = check_plain_pii_columns(columns)
        assert findings == []

    def test_non_pii_plain_column_returns_no_finding(self) -> None:
        columns = [
            {"table_name": "items", "column_name": "title", "sensitivity": "plain"},
        ]
        findings = check_plain_pii_columns(columns)
        assert findings == []

    def test_multiple_pii_columns(self) -> None:
        columns = [
            {"table_name": "users", "column_name": "email", "sensitivity": "plain"},
            {"table_name": "users", "column_name": "phone", "sensitivity": "plain"},
            {"table_name": "users", "column_name": "ssn", "sensitivity": "plain"},
            {"table_name": "users", "column_name": "display_name", "sensitivity": "plain"},
        ]
        findings = check_plain_pii_columns(columns)
        pii_cols = {f.message for f in findings}
        assert len(findings) == 3
        assert any("email" in m for m in pii_cols)
        assert any("phone" in m for m in pii_cols)
        assert any("ssn" in m for m in pii_cols)

    def test_pii_keywords_case_insensitive(self) -> None:
        columns = [
            {"table_name": "t", "column_name": "Email", "sensitivity": "plain"},
            {"table_name": "t", "column_name": "PASSWORD", "sensitivity": "plain"},
        ]
        findings = check_plain_pii_columns(columns)
        assert len(findings) == 2

    def test_pii_keyword_as_substring(self) -> None:
        """Column names like 'user_email' or 'phone_number' should match."""
        columns = [
            {"table_name": "t", "column_name": "user_email", "sensitivity": "plain"},
            {"table_name": "t", "column_name": "phone_number", "sensitivity": "plain"},
        ]
        findings = check_plain_pii_columns(columns)
        assert len(findings) == 2

    def test_all_pii_keywords(self) -> None:
        """All PII keywords should be detected."""
        keywords = ["email", "phone", "ssn", "password", "secret", "token", "address"]
        columns = [
            {"table_name": "t", "column_name": kw, "sensitivity": "plain"}
            for kw in keywords
        ]
        findings = check_plain_pii_columns(columns)
        assert len(findings) == len(keywords)


# ---------------------------------------------------------------------------
# Rule 3: Scoped keys with delete permission
# ---------------------------------------------------------------------------
class TestCheckDeletePermissions:
    """check_delete_permissions(api_keys) -> findings."""

    def test_scoped_key_with_delete_returns_info(self) -> None:
        keys = [
            {
                "role": "scoped",
                "name": "my-key",
                "permissions": {
                    "tables": {"users": ["select", "delete"]},
                },
            },
        ]
        findings = check_delete_permissions(keys)
        assert len(findings) == 1
        f = findings[0]
        assert f.rule_id == "scoped-delete"
        assert f.severity == "info"
        assert f.category == "access-control"
        assert "my-key" in f.message

    def test_scoped_key_without_delete_returns_empty(self) -> None:
        keys = [
            {
                "role": "scoped",
                "name": "read-only",
                "permissions": {
                    "tables": {"users": ["select"]},
                },
            },
        ]
        findings = check_delete_permissions(keys)
        assert findings == []

    def test_non_scoped_key_ignored(self) -> None:
        keys = [
            {
                "role": "service",
                "name": "svc",
                "permissions": None,
            },
            {
                "role": "anon",
                "name": "anon",
                "permissions": None,
            },
        ]
        findings = check_delete_permissions(keys)
        assert findings == []

    def test_scoped_key_no_permissions_ignored(self) -> None:
        keys = [
            {
                "role": "scoped",
                "name": "empty",
                "permissions": None,
            },
        ]
        findings = check_delete_permissions(keys)
        assert findings == []

    def test_multiple_tables_with_delete(self) -> None:
        keys = [
            {
                "role": "scoped",
                "name": "wide-key",
                "permissions": {
                    "tables": {
                        "users": ["select", "delete"],
                        "orders": ["select", "insert", "delete"],
                    },
                },
            },
        ]
        findings = check_delete_permissions(keys)
        assert len(findings) == 1


# ---------------------------------------------------------------------------
# Rule 4: No owner column
# ---------------------------------------------------------------------------
class TestCheckMissingOwnerColumn:
    """check_missing_owner_column(tables, columns_metadata) -> findings."""

    def test_table_without_owner_returns_info(self) -> None:
        columns = [
            {"table_name": "posts", "column_name": "title", "sensitivity": "plain"},
            {"table_name": "posts", "column_name": "body", "sensitivity": "plain"},
        ]
        findings = check_missing_owner_column(["posts"], columns)
        assert len(findings) == 1
        f = findings[0]
        assert f.rule_id == "no-owner"
        assert f.severity == "info"
        assert f.category == "access-control"
        assert f.table == "posts"

    def test_table_with_owner_column_returns_empty(self) -> None:
        columns = [
            {"table_name": "posts", "column_name": "owner", "sensitivity": "plain"},
            {"table_name": "posts", "column_name": "title", "sensitivity": "plain"},
        ]
        findings = check_missing_owner_column(["posts"], columns)
        assert findings == []

    def test_table_with_user_id_column_returns_empty(self) -> None:
        columns = [
            {"table_name": "posts", "column_name": "user_id", "sensitivity": "plain"},
        ]
        findings = check_missing_owner_column(["posts"], columns)
        assert findings == []

    def test_table_with_owner_id_column_returns_empty(self) -> None:
        columns = [
            {"table_name": "posts", "column_name": "owner_id", "sensitivity": "plain"},
        ]
        findings = check_missing_owner_column(["posts"], columns)
        assert findings == []

    def test_multiple_tables_mixed(self) -> None:
        columns = [
            {"table_name": "posts", "column_name": "title", "sensitivity": "plain"},
            {"table_name": "comments", "column_name": "owner_id", "sensitivity": "plain"},
        ]
        findings = check_missing_owner_column(["posts", "comments"], columns)
        assert len(findings) == 1
        assert findings[0].table == "posts"


# ---------------------------------------------------------------------------
# Rule 5: Tables with no indexes beyond PK and row count > 1000
# ---------------------------------------------------------------------------
class TestCheckMissingIndexes:
    """check_missing_indexes(table_stats) -> findings."""

    def test_large_table_no_extra_indexes_returns_info(self) -> None:
        stats = [
            {"table_name": "logs", "row_count": 5000, "index_count": 1},
        ]
        findings = check_missing_indexes(stats)
        assert len(findings) == 1
        f = findings[0]
        assert f.rule_id == "no-indexes"
        assert f.severity == "info"
        assert f.category == "performance"
        assert f.table == "logs"

    def test_large_table_with_indexes_returns_empty(self) -> None:
        stats = [
            {"table_name": "logs", "row_count": 5000, "index_count": 3},
        ]
        findings = check_missing_indexes(stats)
        assert findings == []

    def test_small_table_no_extra_indexes_returns_empty(self) -> None:
        stats = [
            {"table_name": "settings", "row_count": 10, "index_count": 1},
        ]
        findings = check_missing_indexes(stats)
        assert findings == []

    def test_exactly_1000_rows_returns_empty(self) -> None:
        stats = [
            {"table_name": "medium", "row_count": 1000, "index_count": 1},
        ]
        findings = check_missing_indexes(stats)
        assert findings == []

    def test_1001_rows_returns_info(self) -> None:
        stats = [
            {"table_name": "big", "row_count": 1001, "index_count": 1},
        ]
        findings = check_missing_indexes(stats)
        assert len(findings) == 1

    def test_zero_indexes_high_rows(self) -> None:
        """Table with no indexes at all (not even PK) and many rows."""
        stats = [
            {"table_name": "heap", "row_count": 10000, "index_count": 0},
        ]
        findings = check_missing_indexes(stats)
        assert len(findings) == 1
