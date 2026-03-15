"""Unit tests for introspection response building.

Tests the mapping from column metadata (sensitivity) to queryable
flag, operations list, and sensitivity_summary.
"""

from __future__ import annotations

from typing import Any

from pqdb_api.services.schema_engine import (
    build_introspection_column,
    build_introspection_table,
)


class TestBuildIntrospectionColumn:
    """Test per-column introspection metadata."""

    def test_plain_column_is_queryable(self) -> None:
        col = build_introspection_column(
            "age",
            "integer",
            "plain",
        )
        assert col["queryable"] is True

    def test_plain_column_operations(self) -> None:
        col = build_introspection_column(
            "age",
            "integer",
            "plain",
        )
        assert col["operations"] == [
            "eq",
            "gt",
            "lt",
            "gte",
            "lte",
            "in",
            "between",
        ]

    def test_plain_column_has_no_note(self) -> None:
        col = build_introspection_column(
            "age",
            "integer",
            "plain",
        )
        assert "note" not in col

    def test_searchable_column_is_queryable(self) -> None:
        col = build_introspection_column(
            "email",
            "text",
            "searchable",
        )
        assert col["queryable"] is True

    def test_searchable_column_operations(self) -> None:
        col = build_introspection_column(
            "email",
            "text",
            "searchable",
        )
        assert col["operations"] == ["eq", "in"]

    def test_searchable_column_has_no_note(self) -> None:
        col = build_introspection_column(
            "email",
            "text",
            "searchable",
        )
        assert "note" not in col

    def test_private_column_not_queryable(self) -> None:
        col = build_introspection_column(
            "ssn",
            "text",
            "private",
        )
        assert col["queryable"] is False

    def test_private_column_no_operations(self) -> None:
        col = build_introspection_column(
            "ssn",
            "text",
            "private",
        )
        assert "operations" not in col

    def test_private_column_has_note(self) -> None:
        col = build_introspection_column(
            "ssn",
            "text",
            "private",
        )
        assert col["note"] == ("retrieve only \u2014 no server-side filtering")

    def test_column_includes_name_type_sensitivity(
        self,
    ) -> None:
        col = build_introspection_column(
            "email",
            "text",
            "searchable",
        )
        assert col["name"] == "email"
        assert col["type"] == "text"
        assert col["sensitivity"] == "searchable"


class TestBuildIntrospectionTable:
    """Test table-level introspection."""

    def test_empty_columns_list(self) -> None:
        result = build_introspection_table("empty", [])
        assert result["name"] == "empty"
        assert result["columns"] == []
        assert result["sensitivity_summary"] == {
            "searchable": 0,
            "private": 0,
            "plain": 0,
        }

    def test_single_plain_column(self) -> None:
        columns: list[dict[str, object]] = [
            {
                "name": "age",
                "data_type": "integer",
                "sensitivity": "plain",
            },
        ]
        result = build_introspection_table("users", columns)
        assert result["sensitivity_summary"] == {
            "searchable": 0,
            "private": 0,
            "plain": 1,
        }
        cols: list[dict[str, Any]] = result["columns"]  # type: ignore[assignment]
        assert len(cols) == 1
        assert cols[0]["queryable"] is True

    def test_mixed_sensitivity_summary(self) -> None:
        columns: list[dict[str, object]] = [
            {
                "name": "display_name",
                "data_type": "text",
                "sensitivity": "plain",
            },
            {
                "name": "email",
                "data_type": "text",
                "sensitivity": "searchable",
            },
            {
                "name": "ssn",
                "data_type": "text",
                "sensitivity": "private",
            },
        ]
        result = build_introspection_table(
            "profiles",
            columns,
        )
        assert result["sensitivity_summary"] == {
            "searchable": 1,
            "private": 1,
            "plain": 1,
        }

    def test_multiple_same_sensitivity(self) -> None:
        columns: list[dict[str, object]] = [
            {
                "name": "name",
                "data_type": "text",
                "sensitivity": "plain",
            },
            {
                "name": "age",
                "data_type": "integer",
                "sensitivity": "plain",
            },
            {
                "name": "email",
                "data_type": "text",
                "sensitivity": "searchable",
            },
        ]
        result = build_introspection_table("users", columns)
        assert result["sensitivity_summary"] == {
            "searchable": 1,
            "private": 0,
            "plain": 2,
        }

    def test_columns_have_correct_structure(self) -> None:
        columns: list[dict[str, object]] = [
            {
                "name": "email",
                "data_type": "text",
                "sensitivity": "searchable",
            },
            {
                "name": "ssn",
                "data_type": "text",
                "sensitivity": "private",
            },
            {
                "name": "age",
                "data_type": "integer",
                "sensitivity": "plain",
            },
        ]
        result = build_introspection_table("users", columns)
        cols: list[dict[str, Any]] = result["columns"]  # type: ignore[assignment]
        col_map = {c["name"]: c for c in cols}

        # searchable
        assert col_map["email"]["queryable"] is True
        assert col_map["email"]["operations"] == [
            "eq",
            "in",
        ]

        # private
        assert col_map["ssn"]["queryable"] is False
        assert col_map["ssn"]["note"] == (
            "retrieve only \u2014 no server-side filtering"
        )

        # plain
        assert col_map["age"]["queryable"] is True
        assert col_map["age"]["operations"] == [
            "eq",
            "gt",
            "lt",
            "gte",
            "lte",
            "in",
            "between",
        ]
