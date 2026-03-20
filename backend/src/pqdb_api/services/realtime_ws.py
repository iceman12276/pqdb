"""Realtime WebSocket protocol and connection management.

Defines the message protocol, subscription tracking, rate limiting,
and per-event RLS enforcement for WebSocket connections. The route
handler in routes/realtime_ws.py uses these building blocks.
"""

from __future__ import annotations

import json
import time
import uuid
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
    user_id: uuid.UUID | None = None
    user_role: str | None = None
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


# ---------------------------------------------------------------------------
# Per-event RLS enforcement for realtime delivery
# ---------------------------------------------------------------------------
def _find_owner_column(columns_meta: list[dict[str, Any]]) -> str | None:
    """Find the owner column name from column metadata, if any."""
    for col in columns_meta:
        if col.get("is_owner"):
            return str(col["name"])
    return None


def check_realtime_rls(
    *,
    row: dict[str, Any],
    key_role: str,
    user_id: uuid.UUID | None,
    user_role: str | None,
    columns_meta: list[dict[str, Any]],
    policies: list[dict[str, Any]] | None,
) -> bool:
    """Check whether a realtime event should be delivered to a subscriber.

    Uses the fetched row data to evaluate RLS — no extra DB query needed.

    Returns True if the event should be delivered, False to suppress.

    Rules:
    - Service role always receives (admin bypass).
    - If policies is not None (policies exist for this table):
      - Empty list (no match for role/op): deny.
      - condition=none: deny.
      - condition=all: deliver.
      - condition=owner: deliver if row[owner_col] == user_id.
    - If policies is None (no policies for this table):
      - No owner column: deliver (Phase 1 open access).
      - Owner column present: deliver if row[owner_col] == user_id.
    """
    # Service role always bypasses
    if key_role == "service":
        return True

    owner_col = _find_owner_column(columns_meta)

    # Policy-based RLS
    if policies is not None:
        if len(policies) == 0:
            return False

        condition = policies[0].get("condition")

        if condition == "none":
            return False

        if condition == "all":
            return True

        if condition == "owner":
            if user_id is None or owner_col is None:
                return False
            row_owner = row.get(owner_col)
            if row_owner is None:
                return False
            return str(row_owner) == str(user_id)

        # Unknown condition — deny
        return False

    # Fallback: basic owner-column RLS (no policies defined)
    if owner_col is None:
        return True

    if user_id is None:
        return False

    row_owner = row.get(owner_col)
    if row_owner is None:
        return False
    return str(row_owner) == str(user_id)
