"""Unit tests for owner column marker + RLS enforcement (US-028).

Tests:
- ColumnDefinition accepts is_owner flag
- Owner column must be uuid type, plain sensitivity
- At most one owner column per table
- RLS filter injection in CRUD SQL builders
- Role-based RLS bypass (service role skips RLS)
- Error cases (no user context on anon with owner table)
"""

from __future__ import annotations

import uuid

import pytest

from pqdb_api.services.crud import (
    CrudError,
    FilterOp,
    build_select_sql,
    inject_rls_filters,
    validate_owner_for_insert,
    validate_owner_for_update,
)
from pqdb_api.services.schema_engine import (
    ColumnDefinition,
    TableDefinition,
)

# --- Column metadata with owner column ---

COLUMNS_WITH_OWNER = [
    {
        "name": "display_name",
        "sensitivity": "plain",
        "data_type": "text",
        "is_owner": False,
    },
    {"name": "user_id", "sensitivity": "plain", "data_type": "uuid", "is_owner": True},
    {"name": "age", "sensitivity": "plain", "data_type": "integer", "is_owner": False},
]

COLUMNS_WITHOUT_OWNER = [
    {
        "name": "display_name",
        "sensitivity": "plain",
        "data_type": "text",
        "is_owner": False,
    },
    {"name": "age", "sensitivity": "plain", "data_type": "integer", "is_owner": False},
]


class TestColumnDefinitionOwner:
    """ColumnDefinition with is_owner flag."""

    def test_owner_column_defaults_to_false(self) -> None:
        col = ColumnDefinition(name="name", data_type="text", sensitivity="plain")
        assert col.is_owner is False

    def test_owner_column_set_to_true(self) -> None:
        col = ColumnDefinition(
            name="user_id", data_type="uuid", sensitivity="plain", is_owner=True
        )
        assert col.is_owner is True

    def test_owner_column_must_be_uuid_type(self) -> None:
        with pytest.raises(ValueError, match="Owner column must be uuid type"):
            ColumnDefinition(
                name="user_id", data_type="text", sensitivity="plain", is_owner=True
            )

    def test_owner_column_must_be_plain_sensitivity(self) -> None:
        with pytest.raises(
            ValueError, match="Owner column must have plain sensitivity"
        ):
            ColumnDefinition(
                name="user_id", data_type="uuid", sensitivity="private", is_owner=True
            )

    def test_non_owner_column_any_type_ok(self) -> None:
        """Non-owner columns can be any type."""
        col = ColumnDefinition(name="name", data_type="text", sensitivity="plain")
        assert col.is_owner is False


class TestTableDefinitionOwner:
    """TableDefinition enforces at most one owner column."""

    def test_single_owner_column_allowed(self) -> None:
        table = TableDefinition(
            name="items",
            columns=[
                ColumnDefinition(name="title", data_type="text"),
                ColumnDefinition(
                    name="user_id", data_type="uuid", sensitivity="plain", is_owner=True
                ),
            ],
        )
        assert len(table.columns) == 2

    def test_multiple_owner_columns_rejected(self) -> None:
        with pytest.raises(ValueError, match="At most one column.*is_owner"):
            TableDefinition(
                name="items",
                columns=[
                    ColumnDefinition(
                        name="user_id",
                        data_type="uuid",
                        sensitivity="plain",
                        is_owner=True,
                    ),
                    ColumnDefinition(
                        name="owner_id",
                        data_type="uuid",
                        sensitivity="plain",
                        is_owner=True,
                    ),
                ],
            )

    def test_no_owner_column_ok(self) -> None:
        table = TableDefinition(
            name="items",
            columns=[ColumnDefinition(name="title", data_type="text")],
        )
        assert len(table.columns) == 1


class TestInjectRlsFilters:
    """inject_rls_filters adds WHERE owner_col = user_id for anon role."""

    def test_anon_with_user_injects_filter(self) -> None:
        user_id = uuid.uuid4()
        filters: list[tuple[str, FilterOp, object]] = []
        result = inject_rls_filters(
            filters=filters,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
        )
        assert len(result) == 1
        col, op, val = result[0]
        assert col == "user_id"
        assert op == FilterOp.EQ
        assert val == str(user_id)

    def test_anon_preserves_existing_filters(self) -> None:
        user_id = uuid.uuid4()
        existing = [("age", FilterOp.GT, 18)]
        result = inject_rls_filters(
            filters=existing,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
        )
        assert len(result) == 2
        # First filter preserved
        assert result[0] == ("age", FilterOp.GT, 18)
        # RLS filter appended
        assert result[1][0] == "user_id"

    def test_service_role_skips_rls(self) -> None:
        user_id = uuid.uuid4()
        filters: list[tuple[str, FilterOp, object]] = []
        result = inject_rls_filters(
            filters=filters,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="service",
            user_id=user_id,
        )
        assert result == []

    def test_no_owner_column_skips_rls(self) -> None:
        user_id = uuid.uuid4()
        filters: list[tuple[str, FilterOp, object]] = []
        result = inject_rls_filters(
            filters=filters,
            columns_meta=COLUMNS_WITHOUT_OWNER,
            key_role="anon",
            user_id=user_id,
        )
        assert result == []

    def test_anon_no_user_raises_on_owner_table(self) -> None:
        with pytest.raises(CrudError, match="User context required"):
            inject_rls_filters(
                filters=[],
                columns_meta=COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=None,
            )

    def test_anon_no_user_ok_on_no_owner_table(self) -> None:
        result = inject_rls_filters(
            filters=[],
            columns_meta=COLUMNS_WITHOUT_OWNER,
            key_role="anon",
            user_id=None,
        )
        assert result == []


class TestValidateOwnerForInsert:
    """validate_owner_for_insert ensures owner_column matches user_id."""

    def test_anon_owner_matches_user_id(self) -> None:
        user_id = uuid.uuid4()
        row = {"display_name": "Alice", "user_id": str(user_id), "age": 30}
        # Should not raise
        validate_owner_for_insert(
            row=row,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
        )

    def test_anon_owner_mismatch_raises(self) -> None:
        user_id = uuid.uuid4()
        other_id = uuid.uuid4()
        row = {"display_name": "Alice", "user_id": str(other_id), "age": 30}
        with pytest.raises(CrudError, match="Owner column.*must match"):
            validate_owner_for_insert(
                row=row,
                columns_meta=COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=user_id,
            )

    def test_anon_owner_missing_raises(self) -> None:
        user_id = uuid.uuid4()
        row = {"display_name": "Alice", "age": 30}
        with pytest.raises(CrudError, match="Owner column.*required"):
            validate_owner_for_insert(
                row=row,
                columns_meta=COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=user_id,
            )

    def test_service_role_skips_validation(self) -> None:
        other_id = uuid.uuid4()
        row = {"display_name": "Alice", "user_id": str(other_id), "age": 30}
        # Service role doesn't validate owner
        validate_owner_for_insert(
            row=row,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="service",
            user_id=None,
        )

    def test_no_owner_column_skips_validation(self) -> None:
        row = {"display_name": "Alice", "age": 30}
        validate_owner_for_insert(
            row=row,
            columns_meta=COLUMNS_WITHOUT_OWNER,
            key_role="anon",
            user_id=uuid.uuid4(),
        )


class TestValidateOwnerForUpdate:
    """validate_owner_for_update prevents changing owner column on non-service roles."""

    def test_anon_update_with_owner_column_rejected(self) -> None:
        """Anon user cannot include owner column in update values."""
        user_id = uuid.uuid4()
        updates = {"display_name": "New Name", "user_id": str(uuid.uuid4())}
        with pytest.raises(CrudError, match="Cannot change owner column"):
            validate_owner_for_update(
                updates=updates,
                columns_meta=COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=user_id,
            )

    def test_anon_update_owner_to_same_value_rejected(self) -> None:
        """Even setting owner to same user_id is rejected — simplest safe policy."""
        user_id = uuid.uuid4()
        updates = {"user_id": str(user_id)}
        with pytest.raises(CrudError, match="Cannot change owner column"):
            validate_owner_for_update(
                updates=updates,
                columns_meta=COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=user_id,
            )

    def test_anon_update_without_owner_column_ok(self) -> None:
        """Anon user can update non-owner columns freely."""
        user_id = uuid.uuid4()
        updates = {"display_name": "New Name", "age": 25}
        # Should not raise
        validate_owner_for_update(
            updates=updates,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
        )

    def test_service_role_can_update_owner_column(self) -> None:
        """Service role can change owner column (admin operation)."""
        updates = {"user_id": str(uuid.uuid4())}
        # Should not raise
        validate_owner_for_update(
            updates=updates,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="service",
            user_id=None,
        )

    def test_no_owner_column_no_validation(self) -> None:
        """Tables without owner column skip validation entirely."""
        updates = {"display_name": "Test"}
        validate_owner_for_update(
            updates=updates,
            columns_meta=COLUMNS_WITHOUT_OWNER,
            key_role="anon",
            user_id=uuid.uuid4(),
        )


class TestRlsWithSelectSql:
    """Verify RLS filters integrate correctly with build_select_sql."""

    def test_select_with_rls_filter(self) -> None:
        user_id = uuid.uuid4()
        rls_filters = inject_rls_filters(
            filters=[],
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
        )
        sql, params = build_select_sql("items", filters=rls_filters)
        assert "WHERE" in sql
        assert "user_id" in sql
        assert str(user_id) in str(params.values())

    def test_select_with_existing_and_rls_filters(self) -> None:
        user_id = uuid.uuid4()
        existing = [("age", FilterOp.GT, 18)]
        rls_filters = inject_rls_filters(
            filters=existing,
            columns_meta=COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
        )
        sql, params = build_select_sql("items", filters=rls_filters)
        assert "AND" in sql
