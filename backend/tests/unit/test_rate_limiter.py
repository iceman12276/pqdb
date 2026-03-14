"""Unit tests for in-memory rate limiter."""

import uuid
from unittest.mock import patch

from pqdb_api.services.rate_limiter import RateLimiter


class TestRateLimiter:
    """Tests for the in-memory per-project rate limiter."""

    def test_allows_first_request(self) -> None:
        limiter = RateLimiter(max_requests=10, window_seconds=60)
        project_id = uuid.uuid4()
        assert limiter.is_allowed(project_id) is True

    def test_allows_up_to_max_requests(self) -> None:
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        project_id = uuid.uuid4()
        assert limiter.is_allowed(project_id) is True
        assert limiter.is_allowed(project_id) is True
        assert limiter.is_allowed(project_id) is True

    def test_blocks_after_max_requests(self) -> None:
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        project_id = uuid.uuid4()
        for _ in range(3):
            limiter.is_allowed(project_id)
        assert limiter.is_allowed(project_id) is False

    def test_different_projects_have_separate_limits(self) -> None:
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        project_a = uuid.uuid4()
        project_b = uuid.uuid4()
        assert limiter.is_allowed(project_a) is True
        assert limiter.is_allowed(project_b) is True
        # Both should now be exhausted
        assert limiter.is_allowed(project_a) is False
        assert limiter.is_allowed(project_b) is False

    def test_allows_after_window_expires(self) -> None:
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        project_id = uuid.uuid4()

        base_time = 1000.0
        with patch("pqdb_api.services.rate_limiter.time.monotonic") as mock_time:
            mock_time.return_value = base_time
            assert limiter.is_allowed(project_id) is True
            assert limiter.is_allowed(project_id) is False

            # Simulate time passing beyond window
            mock_time.return_value = base_time + 61
            assert limiter.is_allowed(project_id) is True

    def test_prunes_old_timestamps(self) -> None:
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        project_id = uuid.uuid4()

        base_time = 1000.0
        with patch("pqdb_api.services.rate_limiter.time.monotonic") as mock_time:
            mock_time.return_value = base_time
            # Use two requests
            assert limiter.is_allowed(project_id) is True
            assert limiter.is_allowed(project_id) is True
            assert limiter.is_allowed(project_id) is False

            # Move time forward so old entries expire
            mock_time.return_value = base_time + 61
            # Old entries should be pruned, allowing new requests
            assert limiter.is_allowed(project_id) is True
            assert limiter.is_allowed(project_id) is True
            assert limiter.is_allowed(project_id) is False
