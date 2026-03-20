"""Unit tests for the realtime trigger service.

Tests SQL generation, payload format, identifier validation,
and idempotent trigger installation logic.
"""

from __future__ import annotations

import json

import pytest

from pqdb_api.services.realtime import (
    _VALID_IDENTIFIER_RE,
    CREATE_NOTIFY_FUNCTION_SQL,
    _validate_identifier,
    build_create_trigger_sql,
    build_notify_payload,
)


# ---------------------------------------------------------------------------
# Identifier validation
# ---------------------------------------------------------------------------
class TestValidateIdentifier:
    def test_valid_simple_name(self) -> None:
        assert _validate_identifier("users") == "users"

    def test_valid_name_with_underscores(self) -> None:
        assert _validate_identifier("user_profiles") == "user_profiles"

    def test_valid_name_with_digits(self) -> None:
        assert _validate_identifier("table2") == "table2"

    def test_rejects_uppercase(self) -> None:
        with pytest.raises(ValueError, match="Invalid table name"):
            _validate_identifier("Users")

    def test_rejects_leading_digit(self) -> None:
        with pytest.raises(ValueError, match="Invalid table name"):
            _validate_identifier("2table")

    def test_rejects_hyphen(self) -> None:
        with pytest.raises(ValueError, match="Invalid table name"):
            _validate_identifier("user-profiles")

    def test_rejects_semicolon_injection(self) -> None:
        with pytest.raises(ValueError, match="Invalid table name"):
            _validate_identifier("users; DROP TABLE users")

    def test_rejects_empty_string(self) -> None:
        with pytest.raises(ValueError, match="Invalid table name"):
            _validate_identifier("")

    def test_rejects_spaces(self) -> None:
        with pytest.raises(ValueError, match="Invalid table name"):
            _validate_identifier("my table")


# ---------------------------------------------------------------------------
# SQL generation
# ---------------------------------------------------------------------------
class TestBuildCreateTriggerSql:
    def test_generates_correct_ddl(self) -> None:
        sql = build_create_trigger_sql("users")
        assert "CREATE TRIGGER pqdb_realtime_trigger" in sql
        assert "AFTER INSERT OR UPDATE OR DELETE ON users" in sql
        assert "FOR EACH ROW EXECUTE FUNCTION pqdb_notify_changes()" in sql

    def test_different_table_names(self) -> None:
        for table in ("orders", "products", "user_sessions"):
            sql = build_create_trigger_sql(table)
            assert f"ON {table}" in sql

    def test_rejects_invalid_table_name(self) -> None:
        with pytest.raises(ValueError, match="Invalid table name"):
            build_create_trigger_sql("Robert'; DROP TABLE students--")


class TestNotifyFunctionSql:
    def test_function_is_plpgsql(self) -> None:
        assert "LANGUAGE plpgsql" in CREATE_NOTIFY_FUNCTION_SQL

    def test_function_returns_trigger(self) -> None:
        assert "RETURNS trigger" in CREATE_NOTIFY_FUNCTION_SQL

    def test_sends_to_pqdb_realtime_channel(self) -> None:
        assert "pg_notify('pqdb_realtime'" in CREATE_NOTIFY_FUNCTION_SQL

    def test_uses_old_id_for_delete(self) -> None:
        assert "OLD.id" in CREATE_NOTIFY_FUNCTION_SQL

    def test_uses_new_id_for_insert_update(self) -> None:
        assert "NEW.id" in CREATE_NOTIFY_FUNCTION_SQL

    def test_returns_old_for_delete(self) -> None:
        # The function must RETURN OLD for DELETE so the row is actually deleted
        assert "RETURN OLD" in CREATE_NOTIFY_FUNCTION_SQL

    def test_returns_new_for_insert_update(self) -> None:
        assert "RETURN NEW" in CREATE_NOTIFY_FUNCTION_SQL

    def test_payload_contains_table_event_pk(self) -> None:
        assert "TG_TABLE_NAME" in CREATE_NOTIFY_FUNCTION_SQL
        assert "TG_OP" in CREATE_NOTIFY_FUNCTION_SQL
        assert "'pk'" in CREATE_NOTIFY_FUNCTION_SQL


# ---------------------------------------------------------------------------
# Payload format
# ---------------------------------------------------------------------------
class TestBuildNotifyPayload:
    def test_correct_json_structure(self) -> None:
        payload = build_notify_payload("users", "INSERT", "abc-123")
        parsed = json.loads(payload)
        assert parsed == {"table": "users", "event": "INSERT", "pk": "abc-123"}

    def test_delete_event(self) -> None:
        payload = build_notify_payload("orders", "DELETE", "xyz-789")
        parsed = json.loads(payload)
        assert parsed["event"] == "DELETE"
        assert parsed["table"] == "orders"
        assert parsed["pk"] == "xyz-789"

    def test_update_event(self) -> None:
        payload = build_notify_payload("items", "UPDATE", "item-1")
        parsed = json.loads(payload)
        assert parsed["event"] == "UPDATE"

    def test_payload_is_valid_json(self) -> None:
        payload = build_notify_payload("t", "INSERT", "1")
        # Should not raise
        json.loads(payload)

    def test_payload_under_8kb(self) -> None:
        """pg_notify has an 8KB limit. Our minimal payload is well under."""
        payload = build_notify_payload("a" * 63, "DELETE", "a" * 36)
        assert len(payload.encode("utf-8")) < 8192


# ---------------------------------------------------------------------------
# Regex pattern
# ---------------------------------------------------------------------------
class TestIdentifierRegex:
    def test_matches_valid_names(self) -> None:
        for name in ("a", "users", "my_table", "t1", "abc123"):
            assert _VALID_IDENTIFIER_RE.match(name), f"{name} should match"

    def test_rejects_invalid_names(self) -> None:
        for name in ("1abc", "A", "my-table", "my table", "", ";", "a.b"):
            assert not _VALID_IDENTIFIER_RE.match(name), f"{name} should not match"
