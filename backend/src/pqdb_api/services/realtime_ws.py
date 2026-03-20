"""Realtime WebSocket protocol and connection management.

Defines the message protocol, subscription tracking, and rate limiting
for WebSocket connections. The route handler in routes/realtime_ws.py
uses these building blocks.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Protocol constants
# ---------------------------------------------------------------------------
_VALID_MESSAGE_TYPES = {"subscribe", "unsubscribe", "heartbeat"}
_TYPES_REQUIRING_TABLE = {"subscribe", "unsubscribe"}

HEARTBEAT_INTERVAL_SECONDS = 30
MAX_TABLES_PER_CONNECTION = 50
MAX_RECONNECTS_PER_MINUTE = 5


# ---------------------------------------------------------------------------
# Message parsing
# ---------------------------------------------------------------------------
def parse_ws_message(raw: str) -> dict[str, Any]:
    """Parse a raw WebSocket text message into a protocol message.

    Returns a dict with at least a 'type' key. On parse failure,
    returns {"type": "error", "message": "..."}.
    """
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {"type": "error", "message": "Invalid JSON"}

    if not isinstance(data, dict):
        return {"type": "error", "message": "Message must be a JSON object"}

    msg_type = data.get("type")
    if not msg_type:
        return {"type": "error", "message": "Missing 'type' field"}

    if msg_type not in _VALID_MESSAGE_TYPES:
        return {"type": "error", "message": f"Unknown message type: {msg_type}"}

    if msg_type in _TYPES_REQUIRING_TABLE and "table" not in data:
        return {
            "type": "error",
            "message": f"'{msg_type}' requires a 'table' field",
        }

    return dict(data)


# ---------------------------------------------------------------------------
# Subscription manager
# ---------------------------------------------------------------------------
class SubscriptionManager:
    """Tracks which tables a single connection is subscribed to."""

    def __init__(self, max_tables: int = MAX_TABLES_PER_CONNECTION) -> None:
        self._max_tables = max_tables
        self._tables: set[str] = set()

    @property
    def tables(self) -> frozenset[str]:
        return frozenset(self._tables)

    def subscribe(self, table: str) -> bool:
        """Add a table subscription. Returns False if already subscribed or at limit."""
        if table in self._tables:
            return False
        if len(self._tables) >= self._max_tables:
            return False
        self._tables.add(table)
        return True

    def unsubscribe(self, table: str) -> bool:
        """Remove a table subscription. Returns False if not subscribed."""
        if table not in self._tables:
            return False
        self._tables.discard(table)
        return True

    def is_subscribed(self, table: str) -> bool:
        return table in self._tables


# ---------------------------------------------------------------------------
# Connection rate limiter (reconnect throttle)
# ---------------------------------------------------------------------------
class WSRateLimiter:
    """Sliding-window rate limiter for WebSocket connections per IP."""

    def __init__(
        self,
        max_connections: int = MAX_RECONNECTS_PER_MINUTE,
        window_seconds: int = 60,
    ) -> None:
        self._max = max_connections
        self._window = window_seconds
        self._timestamps: dict[str, list[float]] = {}

    def check(self, ip: str) -> bool:
        """Check if a connection from this IP is allowed. Records if allowed."""
        now = time.monotonic()
        cutoff = now - self._window
        entries = [t for t in self._timestamps.get(ip, []) if t > cutoff]

        if len(entries) >= self._max:
            self._timestamps[ip] = entries
            return False

        entries.append(now)
        self._timestamps[ip] = entries
        return True


# ---------------------------------------------------------------------------
# Connection state
# ---------------------------------------------------------------------------
@dataclass
class ConnectionState:
    """State for a single WebSocket connection."""

    project_id: str
    key_role: str
    subscriptions: SubscriptionManager = field(default_factory=SubscriptionManager)


# ---------------------------------------------------------------------------
# Protocol message builders
# ---------------------------------------------------------------------------
class RealtimeProtocol:
    """Builds outgoing WebSocket protocol messages."""

    @staticmethod
    def ack(action: str, table: str) -> dict[str, Any]:
        return {"type": "ack", "action": action, "table": table}

    @staticmethod
    def error(message: str) -> dict[str, Any]:
        return {"type": "error", "message": message}

    @staticmethod
    def heartbeat() -> dict[str, Any]:
        return {"type": "heartbeat", "timestamp": time.time()}

    @staticmethod
    def event(
        table: str,
        event_type: str,
        row: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "type": "event",
            "table": table,
            "event": event_type,
            "row": row,
        }
