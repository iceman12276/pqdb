"""Unit tests for the realtime WebSocket handler.

Tests protocol messages, subscription management, rate limiting,
connection lifecycle, and RLS enforcement without requiring a real database.
"""

from __future__ import annotations

import json
import uuid

from pqdb_api.services.realtime_ws import (
    ConnectionState,
    RealtimeProtocol,
    SubscriptionManager,
    WSRateLimiter,
    check_realtime_rls,
    parse_ws_message,
)


# ---------------------------------------------------------------------------
# Protocol message parsing
# ---------------------------------------------------------------------------
class TestParseWsMessage:
    def test_subscribe_message(self) -> None:
        msg = json.dumps({"type": "subscribe", "table": "users"})
        parsed = parse_ws_message(msg)
        assert parsed["type"] == "subscribe"
        assert parsed["table"] == "users"

    def test_unsubscribe_message(self) -> None:
        msg = json.dumps({"type": "unsubscribe", "table": "users"})
        parsed = parse_ws_message(msg)
        assert parsed["type"] == "unsubscribe"
        assert parsed["table"] == "users"

    def test_heartbeat_message(self) -> None:
        msg = json.dumps({"type": "heartbeat"})
        parsed = parse_ws_message(msg)
        assert parsed["type"] == "heartbeat"

    def test_invalid_json_returns_error(self) -> None:
        parsed = parse_ws_message("not json{")
        assert parsed["type"] == "error"
        assert "Invalid JSON" in parsed["message"]

    def test_missing_type_returns_error(self) -> None:
        parsed = parse_ws_message(json.dumps({"table": "users"}))
        assert parsed["type"] == "error"
        assert "Missing 'type'" in parsed["message"]

    def test_unknown_type_returns_error(self) -> None:
        parsed = parse_ws_message(json.dumps({"type": "explode"}))
        assert parsed["type"] == "error"
        assert "Unknown message type" in parsed["message"]

    def test_subscribe_missing_table_returns_error(self) -> None:
        parsed = parse_ws_message(json.dumps({"type": "subscribe"}))
        assert parsed["type"] == "error"
        assert "table" in parsed["message"].lower()


# ---------------------------------------------------------------------------
# Subscription manager
# ---------------------------------------------------------------------------
class TestSubscriptionManager:
    def test_subscribe_adds_table(self) -> None:
        mgr = SubscriptionManager(max_tables=50)
        result = mgr.subscribe("users")
        assert result is True
        assert "users" in mgr.tables

    def test_subscribe_duplicate_returns_false(self) -> None:
        mgr = SubscriptionManager(max_tables=50)
        mgr.subscribe("users")
        result = mgr.subscribe("users")
        assert result is False

    def test_unsubscribe_removes_table(self) -> None:
        mgr = SubscriptionManager(max_tables=50)
        mgr.subscribe("users")
        result = mgr.unsubscribe("users")
        assert result is True
        assert "users" not in mgr.tables

    def test_unsubscribe_nonexistent_returns_false(self) -> None:
        mgr = SubscriptionManager(max_tables=50)
        result = mgr.unsubscribe("users")
        assert result is False

    def test_max_tables_enforced(self) -> None:
        mgr = SubscriptionManager(max_tables=3)
        mgr.subscribe("t1")
        mgr.subscribe("t2")
        mgr.subscribe("t3")
        result = mgr.subscribe("t4")
        assert result is False
        assert "t4" not in mgr.tables

    def test_is_subscribed(self) -> None:
        mgr = SubscriptionManager(max_tables=50)
        mgr.subscribe("users")
        assert mgr.is_subscribed("users") is True
        assert mgr.is_subscribed("orders") is False

    def test_subscribe_after_unsubscribe(self) -> None:
        mgr = SubscriptionManager(max_tables=1)
        mgr.subscribe("t1")
        mgr.unsubscribe("t1")
        result = mgr.subscribe("t2")
        assert result is True


# ---------------------------------------------------------------------------
# Connection rate limiter (reconnect limiter)
# ---------------------------------------------------------------------------
class TestWSRateLimiter:
    def test_allows_under_limit(self) -> None:
        limiter = WSRateLimiter(max_connections=5, window_seconds=60)
        for _ in range(5):
            assert limiter.check("1.2.3.4") is True

    def test_blocks_over_limit(self) -> None:
        limiter = WSRateLimiter(max_connections=2, window_seconds=60)
        assert limiter.check("1.2.3.4") is True
        assert limiter.check("1.2.3.4") is True
        assert limiter.check("1.2.3.4") is False

    def test_different_ips_independent(self) -> None:
        limiter = WSRateLimiter(max_connections=1, window_seconds=60)
        assert limiter.check("1.2.3.4") is True
        assert limiter.check("5.6.7.8") is True
        assert limiter.check("1.2.3.4") is False


# ---------------------------------------------------------------------------
# ConnectionState
# ---------------------------------------------------------------------------
class TestConnectionState:
    def test_initial_state(self) -> None:
        state = ConnectionState(project_id="proj-1", key_role="anon")
        assert state.project_id == "proj-1"
        assert state.key_role == "anon"
        assert len(state.subscriptions.tables) == 0

    def test_default_max_tables(self) -> None:
        state = ConnectionState(project_id="proj-1", key_role="anon")
        assert state.subscriptions._max_tables == 50


# ---------------------------------------------------------------------------
# RealtimeProtocol message building
# ---------------------------------------------------------------------------
class TestRealtimeProtocol:
    def test_build_ack_message(self) -> None:
        msg = RealtimeProtocol.ack("subscribe", "users")
        assert msg["type"] == "ack"
        assert msg["action"] == "subscribe"
        assert msg["table"] == "users"

    def test_build_error_message(self) -> None:
        msg = RealtimeProtocol.error("something broke")
        assert msg["type"] == "error"
        assert msg["message"] == "something broke"

    def test_build_heartbeat(self) -> None:
        msg = RealtimeProtocol.heartbeat()
        assert msg["type"] == "heartbeat"
        assert "timestamp" in msg

    def test_build_event_insert(self) -> None:
        msg = RealtimeProtocol.event(
            table="users",
            event_type="INSERT",
            row={"id": "abc", "name": "test"},
        )
        assert msg["type"] == "event"
        assert msg["table"] == "users"
        assert msg["event"] == "INSERT"
        assert msg["row"] == {"id": "abc", "name": "test"}

    def test_build_event_delete(self) -> None:
        msg = RealtimeProtocol.event(
            table="users",
            event_type="DELETE",
            row={"id": "abc"},
        )
        assert msg["type"] == "event"
        assert msg["event"] == "DELETE"
        assert msg["row"] == {"id": "abc"}


# ---------------------------------------------------------------------------
# ConnectionState with user_id
# ---------------------------------------------------------------------------
class TestConnectionStateUserId:
    def test_user_id_defaults_to_none(self) -> None:
        state = ConnectionState(project_id="proj-1", key_role="anon")
        assert state.user_id is None

    def test_user_id_can_be_set(self) -> None:
        uid = uuid.uuid4()
        state = ConnectionState(project_id="proj-1", key_role="anon", user_id=uid)
        assert state.user_id == uid

    def test_user_role_defaults_to_none(self) -> None:
        state = ConnectionState(project_id="proj-1", key_role="anon")
        assert state.user_role is None

    def test_user_role_can_be_set(self) -> None:
        state = ConnectionState(
            project_id="proj-1", key_role="anon", user_role="authenticated"
        )
        assert state.user_role == "authenticated"


# ---------------------------------------------------------------------------
# Realtime RLS enforcement (check_realtime_rls)
# ---------------------------------------------------------------------------
_OWNER_USER_ID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
_OTHER_USER_ID = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

_COLS_WITH_OWNER: list[dict[str, object]] = [
    {"name": "id", "sensitivity": "plain", "data_type": "uuid", "is_owner": False},
    {"name": "user_id", "sensitivity": "plain", "data_type": "uuid", "is_owner": True},
    {"name": "data", "sensitivity": "plain", "data_type": "text", "is_owner": False},
]

_COLS_NO_OWNER: list[dict[str, object]] = [
    {"name": "id", "sensitivity": "plain", "data_type": "uuid", "is_owner": False},
    {"name": "data", "sensitivity": "plain", "data_type": "text", "is_owner": False},
]


class TestCheckRealtimeRls:
    """Tests for per-event RLS check before WebSocket delivery."""

    # --- Service role bypass ---

    def test_service_role_always_receives(self) -> None:
        """Service role always receives all events (admin bypass)."""
        row = {"id": "1", "user_id": str(_OTHER_USER_ID), "data": "secret"}
        result = check_realtime_rls(
            row=row,
            key_role="service",
            user_id=None,
            user_role=None,
            columns_meta=_COLS_WITH_OWNER,
            policies=None,
        )
        assert result is True

    def test_service_role_receives_with_none_policy(self) -> None:
        """Service role bypasses even 'none' policies."""
        policy = {"condition": "none", "operation": "select", "role": "authenticated"}
        result = check_realtime_rls(
            row={"id": "1"},
            key_role="service",
            user_id=None,
            user_role=None,
            columns_meta=_COLS_NO_OWNER,
            policies=[policy],
        )
        assert result is True

    # --- No policies + no owner column = open access (Phase 1) ---

    def test_no_policies_no_owner_delivers_to_anon(self) -> None:
        """No policies + no owner column: all roles receive."""
        result = check_realtime_rls(
            row={"id": "1", "data": "hello"},
            key_role="anon",
            user_id=None,
            user_role=None,
            columns_meta=_COLS_NO_OWNER,
            policies=None,
        )
        assert result is True

    # --- No policies + owner column = basic owner-column RLS ---

    def test_no_policies_owner_column_delivers_to_owner(self) -> None:
        """Fallback: owner-column RLS delivers if row matches user_id."""
        row = {"id": "1", "user_id": str(_OWNER_USER_ID), "data": "mine"}
        result = check_realtime_rls(
            row=row,
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role=None,
            columns_meta=_COLS_WITH_OWNER,
            policies=None,
        )
        assert result is True

    def test_no_policies_owner_column_denies_non_owner(self) -> None:
        """Fallback: owner-column RLS denies if row doesn't match user_id."""
        row = {"id": "1", "user_id": str(_OWNER_USER_ID), "data": "mine"}
        result = check_realtime_rls(
            row=row,
            key_role="anon",
            user_id=_OTHER_USER_ID,
            user_role=None,
            columns_meta=_COLS_WITH_OWNER,
            policies=None,
        )
        assert result is False

    def test_no_policies_owner_column_denies_no_user_id(self) -> None:
        """Fallback: owner-column RLS denies if no user_id provided."""
        row = {"id": "1", "user_id": str(_OWNER_USER_ID), "data": "mine"}
        result = check_realtime_rls(
            row=row,
            key_role="anon",
            user_id=None,
            user_role=None,
            columns_meta=_COLS_WITH_OWNER,
            policies=None,
        )
        assert result is False

    # --- Policy condition: all ---

    def test_policy_all_delivers(self) -> None:
        """Policy condition=all: deliver to everyone."""
        policy = {"condition": "all", "operation": "select", "role": "authenticated"}
        result = check_realtime_rls(
            row={"id": "1", "data": "public"},
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_NO_OWNER,
            policies=[policy],
        )
        assert result is True

    # --- Policy condition: none ---

    def test_policy_none_denies(self) -> None:
        """Policy condition=none: don't deliver."""
        policy = {"condition": "none", "operation": "select", "role": "authenticated"}
        result = check_realtime_rls(
            row={"id": "1", "data": "secret"},
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_NO_OWNER,
            policies=[policy],
        )
        assert result is False

    # --- Policy condition: owner ---

    def test_policy_owner_delivers_to_owner(self) -> None:
        """Policy condition=owner: deliver if row owner matches user_id."""
        policy = {"condition": "owner", "operation": "select", "role": "authenticated"}
        row = {"id": "1", "user_id": str(_OWNER_USER_ID), "data": "mine"}
        result = check_realtime_rls(
            row=row,
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_WITH_OWNER,
            policies=[policy],
        )
        assert result is True

    def test_policy_owner_denies_non_owner(self) -> None:
        """Policy condition=owner: deny if row owner doesn't match."""
        policy = {"condition": "owner", "operation": "select", "role": "authenticated"}
        row = {"id": "1", "user_id": str(_OWNER_USER_ID), "data": "mine"}
        result = check_realtime_rls(
            row=row,
            key_role="anon",
            user_id=_OTHER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_WITH_OWNER,
            policies=[policy],
        )
        assert result is False

    def test_policy_owner_denies_no_user_id(self) -> None:
        """Policy condition=owner: deny if no user_id."""
        policy = {"condition": "owner", "operation": "select", "role": "authenticated"}
        row = {"id": "1", "user_id": str(_OWNER_USER_ID), "data": "mine"}
        result = check_realtime_rls(
            row=row,
            key_role="anon",
            user_id=None,
            user_role="authenticated",
            columns_meta=_COLS_WITH_OWNER,
            policies=[policy],
        )
        assert result is False

    def test_policy_owner_denies_no_owner_column(self) -> None:
        """Policy condition=owner: deny if table has no owner column."""
        policy = {"condition": "owner", "operation": "select", "role": "authenticated"}
        row = {"id": "1", "data": "orphan"}
        result = check_realtime_rls(
            row=row,
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_NO_OWNER,
            policies=[policy],
        )
        assert result is False

    # --- No matching policy = deny (default none) ---

    def test_empty_policies_denies(self) -> None:
        """Empty policies list (no match for role/op): deny."""
        result = check_realtime_rls(
            row={"id": "1", "data": "nope"},
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_NO_OWNER,
            policies=[],
        )
        assert result is False

    # --- DELETE events (id-only row) ---

    def test_delete_event_service_role_delivers(self) -> None:
        """DELETE events: service role always receives."""
        result = check_realtime_rls(
            row={"id": "1"},
            key_role="service",
            user_id=None,
            user_role=None,
            columns_meta=_COLS_WITH_OWNER,
            policies=None,
        )
        assert result is True

    def test_delete_event_policy_all_delivers(self) -> None:
        """DELETE events with policy=all: deliver."""
        policy = {"condition": "all", "operation": "select", "role": "authenticated"}
        result = check_realtime_rls(
            row={"id": "1"},
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_NO_OWNER,
            policies=[policy],
        )
        assert result is True

    def test_delete_event_policy_owner_denies_missing_owner_in_row(self) -> None:
        """DELETE events with policy=owner: deny (row has no owner data)."""
        policy = {"condition": "owner", "operation": "select", "role": "authenticated"}
        result = check_realtime_rls(
            row={"id": "1"},
            key_role="anon",
            user_id=_OWNER_USER_ID,
            user_role="authenticated",
            columns_meta=_COLS_WITH_OWNER,
            policies=[policy],
        )
        assert result is False
