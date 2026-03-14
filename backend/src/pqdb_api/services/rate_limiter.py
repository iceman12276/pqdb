"""Simple in-memory rate limiter.

Per-project rate limiting using a sliding window of timestamps.
Not distributed — acceptable for Phase 1 (single process).
"""

from __future__ import annotations

import time
import uuid


class RateLimiter:
    """In-memory sliding-window rate limiter keyed by project ID."""

    def __init__(self, max_requests: int = 10, window_seconds: int = 60) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._requests: dict[uuid.UUID, list[float]] = {}

    def is_allowed(self, project_id: uuid.UUID) -> bool:
        """Check if a request is allowed for the given project.

        Returns True if under the rate limit, False otherwise.
        Records the request timestamp if allowed.
        """
        now = time.monotonic()
        cutoff = now - self._window_seconds

        timestamps = self._requests.get(project_id, [])
        # Prune expired timestamps
        timestamps = [t for t in timestamps if t > cutoff]

        if len(timestamps) >= self._max_requests:
            self._requests[project_id] = timestamps
            return False

        timestamps.append(now)
        self._requests[project_id] = timestamps
        return True
