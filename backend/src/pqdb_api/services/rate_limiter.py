"""In-memory sliding-window rate limiter.

Supports both per-project (UUID) and per-IP (string) keying strategies.
Returns rate limit metadata (remaining, reset) for response headers.
Not distributed — acceptable for Phase 1 (single process).
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Union

# Key can be a project UUID or a string (IP address, email, etc.)
RateLimitKey = Union[uuid.UUID, str]


@dataclass(frozen=True)
class RateLimitResult:
    """Result of a rate limit check."""

    allowed: bool
    limit: int
    remaining: int
    reset_after: float  # seconds until window resets for oldest entry


class RateLimiter:
    """In-memory sliding-window rate limiter.

    Supports any hashable key type (UUID for per-project, str for per-IP).
    """

    def __init__(self, max_requests: int = 10, window_seconds: int = 60) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._requests: dict[RateLimitKey, list[float]] = {}

    def check(self, key: RateLimitKey) -> RateLimitResult:
        """Check rate limit and return detailed result.

        If allowed, records the request timestamp.
        If denied, does NOT record (denied requests don't count).
        """
        now = time.monotonic()
        cutoff = now - self._window_seconds

        timestamps = self._requests.get(key, [])
        timestamps = [t for t in timestamps if t > cutoff]

        if len(timestamps) >= self._max_requests:
            self._requests[key] = timestamps
            # Reset is when the oldest entry in the window expires
            oldest = min(timestamps)
            reset_after = (oldest + self._window_seconds) - now
            return RateLimitResult(
                allowed=False,
                limit=self._max_requests,
                remaining=0,
                reset_after=max(reset_after, 0.0),
            )

        timestamps.append(now)
        self._requests[key] = timestamps
        remaining = self._max_requests - len(timestamps)
        # Reset is when the oldest entry expires
        oldest = min(timestamps)
        reset_after = (oldest + self._window_seconds) - now
        return RateLimitResult(
            allowed=True,
            limit=self._max_requests,
            remaining=remaining,
            reset_after=max(reset_after, 0.0),
        )

    def is_allowed(self, key: RateLimitKey) -> bool:
        """Check if a request is allowed (simple bool API).

        Backward-compatible with existing callers.
        """
        return self.check(key).allowed
