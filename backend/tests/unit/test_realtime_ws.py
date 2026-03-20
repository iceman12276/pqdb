"""Unit tests for the realtime WebSocket handler.

Tests protocol messages, subscription management, rate limiting,
and connection lifecycle without requiring a real database.
"""

from __future__ import annotations

import json

from pqdb_api.services.realtime_ws import (
    ConnectionState,
    RealtimeProtocol,
    SubscriptionManager,
    WSRateLimiter,
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
