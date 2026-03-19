"""Unit tests for audit log service."""

from pqdb_api.services.audit_log import classify_event_type


class TestClassifyEventType:
    """Tests for the event type classifier."""

    def test_database_path(self) -> None:
        assert classify_event_type("/v1/db/tables") == "database"

    def test_database_select(self) -> None:
        assert classify_event_type("/v1/db/users/select") == "database"

    def test_database_insert(self) -> None:
        assert classify_event_type("/v1/db/users/insert") == "database"

    def test_auth_path(self) -> None:
        assert classify_event_type("/v1/auth/login") == "auth"

    def test_auth_signup(self) -> None:
        assert classify_event_type("/v1/auth/signup") == "auth"

    def test_user_auth_path(self) -> None:
        assert classify_event_type("/v1/db/user-auth/login") == "auth"

    def test_unknown_defaults_to_database(self) -> None:
        assert classify_event_type("/v1/projects") == "database"

    def test_health_defaults_to_database(self) -> None:
        assert classify_event_type("/health") == "database"
