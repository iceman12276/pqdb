"""Unit tests for in-memory rate limiter."""

import uuid
from unittest.mock import patch

from pqdb_api.services.rate_limiter import RateLimiter, RateLimitResult


class TestRateLimiter:
    """Tests for the in-memory sliding-window rate limiter."""

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


class TestRateLimiterStringKeys:
    """Test rate limiter with string keys (IP addresses, emails, etc.)."""

    def test_string_key_allowed(self) -> None:
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        assert limiter.is_allowed("192.168.1.1") is True

    def test_string_key_blocks_after_max(self) -> None:
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        assert limiter.is_allowed("192.168.1.1") is True
        assert limiter.is_allowed("192.168.1.1") is True
        assert limiter.is_allowed("192.168.1.1") is False

    def test_different_ips_separate_limits(self) -> None:
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        assert limiter.is_allowed("192.168.1.1") is True
        assert limiter.is_allowed("192.168.1.2") is True
        assert limiter.is_allowed("192.168.1.1") is False
        assert limiter.is_allowed("192.168.1.2") is False

    def test_mixed_key_types(self) -> None:
        """UUID and string keys coexist in the same limiter."""
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        uid = uuid.uuid4()
        assert limiter.is_allowed(uid) is True
        assert limiter.is_allowed("10.0.0.1") is True
        assert limiter.is_allowed(uid) is False
        assert limiter.is_allowed("10.0.0.1") is False


class TestRateLimitResult:
    """Test the RateLimitResult returned by check()."""

    def test_check_returns_result_allowed(self) -> None:
        limiter = RateLimiter(max_requests=10, window_seconds=60)
        result = limiter.check("key")
        assert isinstance(result, RateLimitResult)
        assert result.allowed is True
        assert result.limit == 10
        assert result.remaining == 9
        assert isinstance(result.reset_after, float)
        assert result.reset_after > 0

    def test_check_remaining_decreases(self) -> None:
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        r1 = limiter.check("key")
        assert r1.remaining == 2
        r2 = limiter.check("key")
        assert r2.remaining == 1
        r3 = limiter.check("key")
        assert r3.remaining == 0

    def test_check_denied_returns_zero_remaining(self) -> None:
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        limiter.check("key")
        result = limiter.check("key")
        assert result.allowed is False
        assert result.remaining == 0
        assert result.limit == 1

    def test_check_reset_after_is_time_until_window_expires(self) -> None:
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        base_time = 1000.0
        with patch("pqdb_api.services.rate_limiter.time.monotonic") as mock_time:
            mock_time.return_value = base_time
            result = limiter.check("key")
            assert result.allowed is True
            # Reset should be ~60 seconds from now
            assert 59.0 <= result.reset_after <= 60.0

            # 30 seconds later
            mock_time.return_value = base_time + 30
            result = limiter.check("key")
            assert result.allowed is False
            # Reset should be ~30 seconds from now (oldest entry at base_time + 60)
            assert 29.0 <= result.reset_after <= 30.0

    def test_check_does_not_record_when_denied(self) -> None:
        """Denied requests should not be counted toward the window."""
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        base_time = 1000.0
        with patch("pqdb_api.services.rate_limiter.time.monotonic") as mock_time:
            mock_time.return_value = base_time
            limiter.check("key")  # allowed

            # 100 denied requests should not extend the window
            for _ in range(100):
                mock_time.return_value = base_time + 30
                r = limiter.check("key")
                assert r.allowed is False

            # After the original window expires, should be allowed again
            mock_time.return_value = base_time + 61
            r = limiter.check("key")
            assert r.allowed is True

    def test_is_allowed_backward_compat(self) -> None:
        """is_allowed still works and returns bool."""
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        assert limiter.is_allowed("key") is True
        assert limiter.is_allowed("key") is False
