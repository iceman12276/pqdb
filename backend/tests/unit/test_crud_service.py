"""Unit tests for the CRUD service — query building and validation logic.

Tests filter validation, column resolution, SQL generation for
insert/select/update/delete with blind-index-aware routing.
"""

from __future__ import annotations

import pytest

from pqdb_api.services.crud import (
    CrudError,
    FilterOp,
    build_delete_sql,
    build_insert_sql,
    build_select_sql,
    build_update_sql,
    resolve_physical_column,
    validate_columns_for_insert,
    validate_filter_column,
)


# --- Column metadata fixtures ---

COLUMNS_META = [
    {"name": "display_name", "sensitivity": "plain", "data_type": "text"},
    {"name": "email", "sensitivity": "searchable", "data_type": "text"},
    {"name": "ssn", "sensitivity": "private", "data_type": "text"},
    {"name": "age", "sensitivity": "plain", "data_type": "integer"},
]


class TestResolvePhysicalColumn:
    """Resolve logical column names to physical column names."""

    def test_plain_column_unchanged(self) -> None:
        assert resolve_physical_column("display_name", COLUMNS_META) == "display_name"

    def test_plain_integer_unchanged(self) -> None:
        assert resolve_physical_column("age", COLUMNS_META) == "age"

    def test_searchable_for_insert_uses_encrypted(self) -> None:
        assert (
            resolve_physical_column("email", COLUMNS_META, for_insert=True)
            == "email_encrypted"
        )

    def test_private_for_insert_uses_encrypted(self) -> None:
        assert (
            resolve_physical_column("ssn", COLUMNS_META, for_insert=True)
            == "ssn_encrypted"
        )

    def test_unknown_column_raises(self) -> None:
        with pytest.raises(CrudError, match="Unknown column"):
            resolve_physical_column("nonexistent", COLUMNS_META)


class TestValidateFilterColumn:
    """Validate filter columns — private columns cannot be filtered."""

    def test_plain_column_allowed(self) -> None:
        # Should not raise
        validate_filter_column("display_name", COLUMNS_META)

    def test_searchable_column_eq_allowed(self) -> None:
        validate_filter_column("email", COLUMNS_META, op=FilterOp.EQ)

    def test_searchable_column_in_allowed(self) -> None:
        validate_filter_column("email", COLUMNS_META, op=FilterOp.IN)

    def test_searchable_column_gt_rejected(self) -> None:
        with pytest.raises(CrudError, match="only supports eq/in"):
            validate_filter_column("email", COLUMNS_META, op=FilterOp.GT)

    def test_searchable_column_lt_rejected(self) -> None:
        with pytest.raises(CrudError, match="only supports eq/in"):
            validate_filter_column("email", COLUMNS_META, op=FilterOp.LT)

    def test_private_column_rejected(self) -> None:
        with pytest.raises(CrudError, match="Cannot filter on private"):
            validate_filter_column("ssn", COLUMNS_META)

    def test_unknown_column_rejected(self) -> None:
        with pytest.raises(CrudError, match="Unknown column"):
            validate_filter_column("nonexistent", COLUMNS_META)

    def test_plain_column_all_ops_allowed(self) -> None:
        for op in FilterOp:
            validate_filter_column("age", COLUMNS_META, op=op)


class TestValidateColumnsForInsert:
    """Validate insert payloads map correctly to physical columns."""

    def test_plain_column_passthrough(self) -> None:
        result = validate_columns_for_insert({"display_name": "Alice"}, COLUMNS_META)
        assert result == {"display_name": "Alice"}

    def test_searchable_maps_to_encrypted_and_index(self) -> None:
        result = validate_columns_for_insert(
            {"email": b"encrypted_blob", "email_index": "blind_idx"}, COLUMNS_META
        )
        assert "email_encrypted" in result
        assert "email_index" in result

    def test_private_maps_to_encrypted(self) -> None:
        result = validate_columns_for_insert(
            {"ssn": b"encrypted_blob"}, COLUMNS_META
        )
        assert "ssn_encrypted" in result

    def test_unknown_column_rejected(self) -> None:
        with pytest.raises(CrudError, match="Unknown column"):
            validate_columns_for_insert({"nonexistent": "x"}, COLUMNS_META)

    def test_mixed_columns(self) -> None:
        result = validate_columns_for_insert(
            {
                "display_name": "Bob",
                "email": b"enc_email",
                "email_index": "idx_email",
                "ssn": b"enc_ssn",
                "age": 30,
            },
            COLUMNS_META,
        )
        assert result["display_name"] == "Bob"
        assert result["email_encrypted"] == b"enc_email"
        assert result["email_index"] == "idx_email"
        assert result["ssn_encrypted"] == b"enc_ssn"
        assert result["age"] == 30


class TestBuildInsertSql:
    """Test SQL generation for INSERT statements."""

    def test_single_plain_column(self) -> None:
        sql, params = build_insert_sql("users", {"display_name": "Alice"})
        assert '"users"' in sql
        assert "display_name" in sql
        assert params["display_name"] == "Alice"

    def test_multiple_columns(self) -> None:
        sql, params = build_insert_sql(
            "users", {"display_name": "Alice", "age": 30}
        )
        assert "display_name" in sql
        assert "age" in sql
        assert params["display_name"] == "Alice"
        assert params["age"] == 30

    def test_returns_returning_star(self) -> None:
        sql, _ = build_insert_sql("users", {"display_name": "Alice"})
        assert "RETURNING *" in sql


class TestBuildSelectSql:
    """Test SQL generation for SELECT statements."""

    def test_select_all_columns(self) -> None:
        sql, params = build_select_sql("users")
        assert 'SELECT * FROM "users"' in sql
        assert params == {}

    def test_select_specific_columns(self) -> None:
        sql, _ = build_select_sql("users", columns=["display_name", "age"])
        assert "display_name" in sql
        assert "age" in sql

    def test_select_with_eq_filter(self) -> None:
        sql, params = build_select_sql(
            "users", filters=[("display_name", FilterOp.EQ, "Alice")]
        )
        assert "display_name = :f_0" in sql
        assert params["f_0"] == "Alice"

    def test_select_with_gt_filter(self) -> None:
        sql, params = build_select_sql(
            "users", filters=[("age", FilterOp.GT, 18)]
        )
        assert "age > :f_0" in sql
        assert params["f_0"] == 18

    def test_select_with_lt_filter(self) -> None:
        sql, params = build_select_sql(
            "users", filters=[("age", FilterOp.LT, 100)]
        )
        assert "age < :f_0" in sql

    def test_select_with_gte_filter(self) -> None:
        sql, params = build_select_sql(
            "users", filters=[("age", FilterOp.GTE, 18)]
        )
        assert "age >= :f_0" in sql

    def test_select_with_lte_filter(self) -> None:
        sql, params = build_select_sql(
            "users", filters=[("age", FilterOp.LTE, 100)]
        )
        assert "age <= :f_0" in sql

    def test_select_with_in_filter(self) -> None:
        sql, params = build_select_sql(
            "users", filters=[("age", FilterOp.IN, [1, 2, 3])]
        )
        assert "age IN" in sql
        # IN generates individual params
        assert params["f_0_0"] == 1
        assert params["f_0_1"] == 2
        assert params["f_0_2"] == 3

    def test_select_with_limit(self) -> None:
        sql, params = build_select_sql("users", limit=10)
        assert "LIMIT :limit" in sql
        assert params["limit"] == 10

    def test_select_with_offset(self) -> None:
        sql, params = build_select_sql("users", offset=5)
        assert "OFFSET :offset" in sql
        assert params["offset"] == 5

    def test_select_with_order_by(self) -> None:
        sql, _ = build_select_sql("users", order_by=[("age", "asc")])
        assert "ORDER BY" in sql
        assert "age ASC" in sql

    def test_select_with_order_by_desc(self) -> None:
        sql, _ = build_select_sql("users", order_by=[("age", "desc")])
        assert "age DESC" in sql

    def test_select_with_multiple_filters(self) -> None:
        sql, params = build_select_sql(
            "users",
            filters=[
                ("display_name", FilterOp.EQ, "Alice"),
                ("age", FilterOp.GT, 18),
            ],
        )
        assert "display_name = :f_0" in sql
        assert "age > :f_1" in sql
        assert params["f_0"] == "Alice"
        assert params["f_1"] == 18


class TestBuildUpdateSql:
    """Test SQL generation for UPDATE statements."""

    def test_update_single_column(self) -> None:
        sql, params = build_update_sql(
            "users",
            updates={"display_name": "Bob"},
            filters=[("display_name", FilterOp.EQ, "Alice")],
        )
        assert "UPDATE" in sql
        assert '"users"' in sql
        assert "display_name = :u_display_name" in sql
        assert params["u_display_name"] == "Bob"
        assert "display_name = :f_0" in sql
        assert params["f_0"] == "Alice"

    def test_update_returns_returning_star(self) -> None:
        sql, _ = build_update_sql(
            "users",
            updates={"display_name": "Bob"},
            filters=[("display_name", FilterOp.EQ, "Alice")],
        )
        assert "RETURNING *" in sql

    def test_update_requires_filters(self) -> None:
        with pytest.raises(CrudError, match="at least one filter"):
            build_update_sql("users", updates={"display_name": "Bob"}, filters=[])


class TestBuildDeleteSql:
    """Test SQL generation for DELETE statements."""

    def test_delete_with_eq_filter(self) -> None:
        sql, params = build_delete_sql(
            "users", filters=[("display_name", FilterOp.EQ, "Alice")]
        )
        assert "DELETE FROM" in sql
        assert '"users"' in sql
        assert "display_name = :f_0" in sql
        assert params["f_0"] == "Alice"

    def test_delete_returns_returning_star(self) -> None:
        sql, _ = build_delete_sql(
            "users", filters=[("display_name", FilterOp.EQ, "Alice")]
        )
        assert "RETURNING *" in sql

    def test_delete_requires_filters(self) -> None:
        with pytest.raises(CrudError, match="at least one filter"):
            build_delete_sql("users", filters=[])
