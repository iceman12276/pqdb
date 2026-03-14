"""Unit tests for schema migration DDL generation (US-014).

Tests build_add_column_ddl and related pure functions.
"""

from __future__ import annotations

import pytest

from pqdb_api.services.schema_engine import (
    ColumnDefinition,
    build_add_column_ddl,
)


class TestBuildAddColumnDDL:
    """Test DDL generation for adding columns to an existing table."""

    def test_plain_column_generates_single_alter(self) -> None:
        col = ColumnDefinition(name="age", data_type="integer", sensitivity="plain")
        ddl = build_add_column_ddl("users", col)
        assert len(ddl) == 1
        assert ddl[0] == 'ALTER TABLE "users" ADD COLUMN age integer'

    def test_private_column_generates_encrypted_alter(self) -> None:
        col = ColumnDefinition(name="ssn", data_type="text", sensitivity="private")
        ddl = build_add_column_ddl("users", col)
        assert len(ddl) == 1
        assert ddl[0] == 'ALTER TABLE "users" ADD COLUMN ssn_encrypted bytea'

    def test_searchable_column_generates_two_alters(self) -> None:
        col = ColumnDefinition(name="email", data_type="text", sensitivity="searchable")
        ddl = build_add_column_ddl("users", col)
        assert len(ddl) == 2
        assert ddl[0] == 'ALTER TABLE "users" ADD COLUMN email_encrypted bytea'
        assert ddl[1] == 'ALTER TABLE "users" ADD COLUMN email_index text'

    def test_validates_table_name(self) -> None:
        col = ColumnDefinition(name="x", data_type="text")
        with pytest.raises(ValueError, match="invalid characters"):
            build_add_column_ddl("bad table!", col)

    def test_plain_boolean_column(self) -> None:
        col = ColumnDefinition(name="active", data_type="boolean", sensitivity="plain")
        ddl = build_add_column_ddl("items", col)
        assert ddl[0] == 'ALTER TABLE "items" ADD COLUMN active boolean'
