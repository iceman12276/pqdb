"""Unit tests for the CRUD service (US-012).

Tests column validation, physical column resolution, filter validation,
and SQL generation for insert/select/update/delete operations.
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
    """Map logical column names to physical column names."""

    def test_plain_unchanged(self) -> None:
        assert resolve_physical_column("display_name", COLUMNS_META) == "display_name"

    def test_searchable_for_filter_uses_index(self) -> None:
        result = resolve_physical_column("email", COLUMNS_META, for_filter=True)
        assert result == "email_index"

    def test_searchable_for_insert_uses_encrypted(self) -> None:
        result = resolve_physical_column("email", COLUMNS_META, for_insert=True)
        assert result == "email_encrypted"

    def test_private_for_insert_uses_encrypted(self) -> None:
        result = resolve_physical_column("ssn", COLUMNS_META, for_insert=True)
        assert result == "ssn_encrypted"

    def test_private_for_filter_raises(self) -> None:
        with pytest.raises(CrudError, match="Cannot filter"):
            resolve_physical_column("ssn", COLUMNS_META, for_filter=True)

    def test_unknown_column_raises(self) -> None:
        with pytest.raises(CrudError, match="Unknown column"):
            resolve_physical_column("nonexistent", COLUMNS_META)


class TestValidateFilterColumn:
    """Validate filter operations against column sensitivity."""

    def test_eq_on_plain_allowed(self) -> None:
        validate_filter_column("display_name", COLUMNS_META, op=FilterOp.EQ)

    def test_eq_on_searchable_allowed(self) -> None:
        validate_filter_column("email", COLUMNS_META, op=FilterOp.EQ)

    def test_in_on_searchable_allowed(self) -> None:
        validate_filter_column("email", COLUMNS_META, op=FilterOp.IN)

    def test_range_on_plain_allowed(self) -> None:
        validate_filter_column("age", COLUMNS_META, op=FilterOp.GT)

    def test_range_on_searchable_raises(self) -> None:
        with pytest.raises(CrudError, match="eq/in"):
            validate_filter_column("email", COLUMNS_META, op=FilterOp.GT)

    def test_any_op_on_private_raises(self) -> None:
        with pytest.raises(CrudError, match="Cannot filter"):
            validate_filter_column("ssn", COLUMNS_META, op=FilterOp.EQ)

    def test_unknown_column_raises(self) -> None:
        with pytest.raises(CrudError, match="Unknown column"):
            validate_filter_column("nonexistent", COLUMNS_META)


class TestValidateColumnsForInsert:
    """Check that incoming columns are validated and mapped."""

    def test_plain_column_passthrough(self) -> None:
        result = validate_columns_for_insert(
            {"display_name": "Alice"}, COLUMNS_META
        )
        assert result == {"display_name": "Alice"}

    def test_searchable_maps_to_encrypted(self) -> None:
        result = validate_columns_for_insert(
            {"email": "cipher"}, COLUMNS_META
        )
        assert result == {"email_encrypted": "cipher"}

    def test_searchable_with_index(self) -> None:
        result = validate_columns_for_insert(
            {"email": "cipher", "email_index": "hmac_hex"}, COLUMNS_META
        )
        assert result["email_encrypted"] == "cipher"
        assert result["email_index"] == "hmac_hex"

    def test_private_maps_to_encrypted(self) -> None:
        result = validate_columns_for_insert(
            {"ssn": "ssn_cipher"}, COLUMNS_META
        )
        assert result == {"ssn_encrypted": "ssn_cipher"}

    def test_unknown_column_raises(self) -> None:
        with pytest.raises(CrudError, match="Unknown column"):
            validate_columns_for_insert({"nonexistent": "val"}, COLUMNS_META)


class TestBuildInsertSQL:
    """Test SQL generation for INSERT."""

    def test_single_row(self) -> None:
        sql, params = build_insert_sql(
            "users", {"display_name": "Alice", "age": 30}
        )
        assert '"users"' in sql
        assert "display_name" in sql
        assert "age" in sql
        assert "RETURNING" in sql
        assert params["display_name"] == "Alice"

    def test_encrypted_columns_passed_through(self) -> None:
        sql, params = build_insert_sql(
            "users",
            {"email_encrypted": "cipher", "email_index": "hmac_hex"},
        )
        assert "email_encrypted" in sql
        assert "email_index" in sql


class TestBuildSelectSQL:
    """Test SQL generation for SELECT."""

    def test_select_all(self) -> None:
        sql, params = build_select_sql("users")
        assert "SELECT *" in sql
        assert '"users"' in sql

    def test_select_specific_columns(self) -> None:
        sql, params = build_select_sql(
            "users", columns=["display_name", "age"]
        )
        assert "display_name" in sql
        assert "age" in sql

    def test_eq_filter(self) -> None:
        sql, params = build_select_sql(
            "users",
            filters=[("email_index", FilterOp.EQ, "hmac_hex")],
        )
        assert "email_index" in sql
        assert "=" in sql

    def test_in_filter(self) -> None:
        sql, params = build_select_sql(
            "users",
            filters=[("age", FilterOp.IN, [25, 30])],
        )
        assert "IN" in sql.upper()

    def test_range_filter(self) -> None:
        sql, params = build_select_sql(
            "users",
            filters=[("age", FilterOp.GT, 18)],
        )
        assert ">" in sql

    def test_limit(self) -> None:
        sql, _ = build_select_sql("users", limit=10)
        assert "LIMIT" in sql.upper()

    def test_offset(self) -> None:
        sql, _ = build_select_sql("users", offset=5)
        assert "OFFSET" in sql.upper()

    def test_order_by(self) -> None:
        sql, _ = build_select_sql(
            "users", order_by=[("age", "desc")]
        )
        assert "ORDER BY" in sql.upper()
        assert "DESC" in sql.upper()

    def test_multiple_filters(self) -> None:
        sql, params = build_select_sql(
            "users",
            filters=[
                ("age", FilterOp.GTE, 18),
                ("age", FilterOp.LT, 65),
            ],
        )
        assert "AND" in sql.upper()


class TestBuildUpdateSQL:
    """Test SQL generation for UPDATE."""

    def test_basic_update(self) -> None:
        sql, params = build_update_sql(
            "users",
            updates={"display_name": "Bob"},
            filters=[("email_index", FilterOp.EQ, "hmac")],
        )
        assert "UPDATE" in sql.upper()
        assert '"users"' in sql
        assert "SET" in sql.upper()
        assert "WHERE" in sql.upper()
        assert "RETURNING" in sql.upper()

    def test_update_requires_filters(self) -> None:
        with pytest.raises(CrudError, match="at least one filter"):
            build_update_sql(
                "users",
                updates={"display_name": "Bob"},
                filters=[],
            )


class TestBuildDeleteSQL:
    """Test SQL generation for DELETE."""

    def test_basic_delete(self) -> None:
        sql, params = build_delete_sql(
            "users",
            filters=[("email_index", FilterOp.EQ, "hmac")],
        )
        assert "DELETE" in sql.upper()
        assert '"users"' in sql
        assert "WHERE" in sql.upper()
        assert "RETURNING" in sql.upper()

    def test_delete_without_filters_raises(self) -> None:
        with pytest.raises(CrudError, match="at least one filter"):
            build_delete_sql("users", filters=[])
