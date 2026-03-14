"""Unit tests for the schema engine service.

Tests shadow column mapping, metadata generation, SQL type mapping,
and column definition validation.
"""

from __future__ import annotations

import pytest

from pqdb_api.services.schema_engine import (
    ColumnDefinition,
    TableDefinition,
    build_physical_columns_sql,
    map_sensitivity_to_physical,
    validate_column_name,
    validate_table_name,
)


class TestValidateTableName:
    """Table name validation."""

    def test_valid_simple_name(self) -> None:
        assert validate_table_name("users") == "users"

    def test_valid_with_underscores(self) -> None:
        assert validate_table_name("user_profiles") == "user_profiles"

    def test_valid_with_numbers(self) -> None:
        assert validate_table_name("table1") == "table1"

    def test_rejects_empty(self) -> None:
        with pytest.raises(ValueError, match="Table name must not be empty"):
            validate_table_name("")

    def test_rejects_spaces(self) -> None:
        with pytest.raises(ValueError, match="invalid characters"):
            validate_table_name("my table")

    def test_rejects_sql_injection(self) -> None:
        with pytest.raises(ValueError, match="invalid characters"):
            validate_table_name("users; DROP TABLE")

    def test_rejects_leading_number(self) -> None:
        with pytest.raises(ValueError, match="must start with a letter"):
            validate_table_name("1users")

    def test_rejects_reserved_pqdb_prefix(self) -> None:
        with pytest.raises(ValueError, match="invalid characters"):
            validate_table_name("_pqdb_something")

    def test_rejects_pg_prefix(self) -> None:
        with pytest.raises(ValueError, match="reserved"):
            validate_table_name("pg_tables")


class TestValidateColumnName:
    """Column name validation."""

    def test_valid_simple_name(self) -> None:
        assert validate_column_name("email") == "email"

    def test_rejects_empty(self) -> None:
        with pytest.raises(ValueError, match="Column name must not be empty"):
            validate_column_name("")

    def test_rejects_reserved_suffix_encrypted(self) -> None:
        with pytest.raises(ValueError, match="reserved suffix"):
            validate_column_name("data_encrypted")

    def test_rejects_reserved_suffix_index(self) -> None:
        with pytest.raises(ValueError, match="reserved suffix"):
            validate_column_name("data_index")

    def test_rejects_id_column(self) -> None:
        with pytest.raises(ValueError, match="reserved"):
            validate_column_name("id")


class TestMapSensitivityToPhysical:
    """Test mapping sensitivity levels to physical column definitions."""

    def test_plain_column(self) -> None:
        col = ColumnDefinition(name="name", data_type="text", sensitivity="plain")
        physical = map_sensitivity_to_physical(col)
        assert len(physical) == 1
        assert physical[0] == ("name", "text")

    def test_private_column(self) -> None:
        col = ColumnDefinition(name="ssn", data_type="text", sensitivity="private")
        physical = map_sensitivity_to_physical(col)
        assert len(physical) == 1
        assert physical[0] == ("ssn_encrypted", "bytea")

    def test_searchable_column(self) -> None:
        col = ColumnDefinition(name="email", data_type="text", sensitivity="searchable")
        physical = map_sensitivity_to_physical(col)
        assert len(physical) == 2
        assert physical[0] == ("email_encrypted", "bytea")
        assert physical[1] == ("email_index", "text")

    def test_plain_integer_type(self) -> None:
        col = ColumnDefinition(name="age", data_type="integer", sensitivity="plain")
        physical = map_sensitivity_to_physical(col)
        assert physical[0] == ("age", "integer")

    def test_plain_boolean_type(self) -> None:
        col = ColumnDefinition(name="active", data_type="boolean", sensitivity="plain")
        physical = map_sensitivity_to_physical(col)
        assert physical[0] == ("active", "boolean")

    def test_plain_vector_type(self) -> None:
        col = ColumnDefinition(
            name="embedding", data_type="vector(1536)", sensitivity="plain"
        )
        physical = map_sensitivity_to_physical(col)
        assert physical[0] == ("embedding", "vector(1536)")

    def test_sensitive_always_maps_to_bytea(self) -> None:
        """Regardless of declared data_type, encrypted columns are bytea."""
        col = ColumnDefinition(name="age", data_type="integer", sensitivity="private")
        physical = map_sensitivity_to_physical(col)
        assert physical[0] == ("age_encrypted", "bytea")

    def test_default_sensitivity_is_plain(self) -> None:
        col = ColumnDefinition(name="name", data_type="text")
        assert col.sensitivity == "plain"


class TestBuildPhysicalColumnsSql:
    """Test building SQL column definitions from a table definition."""

    def test_single_plain_column(self) -> None:
        table = TableDefinition(
            name="users",
            columns=[
                ColumnDefinition(name="name", data_type="text", sensitivity="plain"),
            ],
        )
        sql_parts = build_physical_columns_sql(table)
        assert "name text" in sql_parts

    def test_mixed_sensitivity_columns(self) -> None:
        table = TableDefinition(
            name="users",
            columns=[
                ColumnDefinition(name="name", data_type="text", sensitivity="plain"),
                ColumnDefinition(
                    name="email", data_type="text", sensitivity="searchable"
                ),
                ColumnDefinition(name="ssn", data_type="text", sensitivity="private"),
            ],
        )
        sql_parts = build_physical_columns_sql(table)
        assert "name text" in sql_parts
        assert "email_encrypted bytea" in sql_parts
        assert "email_index text" in sql_parts
        assert "ssn_encrypted bytea" in sql_parts
        # Original sensitive column names must NOT appear
        assert not any("email text" in p for p in sql_parts)
        assert not any("ssn text" in p for p in sql_parts)

    def test_includes_id_column(self) -> None:
        """Every table gets an auto-generated bigint id primary key."""
        table = TableDefinition(
            name="users",
            columns=[
                ColumnDefinition(name="name", data_type="text", sensitivity="plain"),
            ],
        )
        sql_parts = build_physical_columns_sql(table)
        assert "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY" in sql_parts

    def test_includes_timestamps(self) -> None:
        """Every table gets created_at and updated_at timestamps."""
        table = TableDefinition(
            name="users",
            columns=[
                ColumnDefinition(name="name", data_type="text", sensitivity="plain"),
            ],
        )
        sql_parts = build_physical_columns_sql(table)
        joined = " ".join(sql_parts)
        assert "created_at" in joined
        assert "updated_at" in joined


class TestColumnDefinition:
    """Test ColumnDefinition dataclass."""

    def test_valid_sensitivities(self) -> None:
        for s in ("plain", "private", "searchable"):
            col = ColumnDefinition(name="test", data_type="text", sensitivity=s)
            assert col.sensitivity == s

    def test_invalid_sensitivity_rejected(self) -> None:
        with pytest.raises(ValueError, match="sensitivity"):
            ColumnDefinition(name="test", data_type="text", sensitivity="encrypted")  # type: ignore[arg-type]


class TestTableDefinition:
    """Test TableDefinition dataclass."""

    def test_table_must_have_columns(self) -> None:
        with pytest.raises(ValueError, match="at least one column"):
            TableDefinition(name="empty", columns=[])

    def test_duplicate_column_names_rejected(self) -> None:
        with pytest.raises(ValueError, match="Duplicate column"):
            TableDefinition(
                name="dup",
                columns=[
                    ColumnDefinition(name="email", data_type="text"),
                    ColumnDefinition(name="email", data_type="text"),
                ],
            )
