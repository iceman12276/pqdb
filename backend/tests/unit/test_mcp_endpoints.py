"""Unit tests for MCP expansion endpoints.

Tests the endpoint logic in isolation:
1. POST /v1/db/sql — raw SQL execution
2. GET /v1/db/extensions — list Postgres extensions
3. GET /v1/db/migrations — list Alembic migration history
4. POST /v1/projects/{id}/pause — pause a project
5. POST /v1/projects/{id}/restore — restore a paused project
"""

from __future__ import annotations

import pytest


class TestSqlEndpointValidation:
    """Unit tests for POST /v1/db/sql request validation."""

    def test_sql_request_requires_query_field(self) -> None:
        """The SqlRequest model must require a query string."""
        from pqdb_api.routes.db import SqlRequest

        with pytest.raises(Exception):
            SqlRequest()  # type: ignore[call-arg]

    def test_sql_request_accepts_valid_query(self) -> None:
        from pqdb_api.routes.db import SqlRequest

        req = SqlRequest(query="SELECT 1")
        assert req.query == "SELECT 1"
        assert req.mode == "read"

    def test_sql_request_mode_defaults_to_read(self) -> None:
        from pqdb_api.routes.db import SqlRequest

        req = SqlRequest(query="SELECT 1")
        assert req.mode == "read"

    def test_sql_request_accepts_write_mode(self) -> None:
        from pqdb_api.routes.db import SqlRequest

        req = SqlRequest(query="INSERT INTO t VALUES (1)", mode="write")
        assert req.mode == "write"

    def test_sql_request_rejects_invalid_mode(self) -> None:
        from pqdb_api.routes.db import SqlRequest

        with pytest.raises(ValueError):
            SqlRequest(query="SELECT 1", mode="admin")


class TestPauseRestoreValidation:
    """Unit tests for pause/restore status transitions."""

    def test_pause_only_from_active(self) -> None:
        """Pausing is only valid when status is 'active'."""
        from pqdb_api.routes.projects import _validate_pause_transition

        # Should not raise
        _validate_pause_transition("active")

    def test_pause_from_paused_raises(self) -> None:
        from pqdb_api.routes.projects import _validate_pause_transition

        with pytest.raises(ValueError, match="Cannot pause"):
            _validate_pause_transition("paused")

    def test_pause_from_archived_raises(self) -> None:
        from pqdb_api.routes.projects import _validate_pause_transition

        with pytest.raises(ValueError, match="Cannot pause"):
            _validate_pause_transition("archived")

    def test_restore_from_paused(self) -> None:
        """Restoring is valid from 'paused' status."""
        from pqdb_api.routes.projects import _validate_restore_transition

        _validate_restore_transition("paused")

    def test_restore_from_archived(self) -> None:
        """Restoring is valid from 'archived' status."""
        from pqdb_api.routes.projects import _validate_restore_transition

        _validate_restore_transition("archived")

    def test_restore_from_active_raises(self) -> None:
        from pqdb_api.routes.projects import _validate_restore_transition

        with pytest.raises(ValueError, match="Cannot restore"):
            _validate_restore_transition("active")

    def test_restore_from_provisioning_raises(self) -> None:
        from pqdb_api.routes.projects import _validate_restore_transition

        with pytest.raises(ValueError, match="Cannot restore"):
            _validate_restore_transition("provisioning")


class TestExtensionResponseShape:
    """Verify the extension response model shape."""

    def test_extension_item_model(self) -> None:
        from pqdb_api.routes.db import ExtensionItem

        ext = ExtensionItem(name="pgvector", version="0.7.0")
        assert ext.name == "pgvector"
        assert ext.version == "0.7.0"


class TestMigrationResponseShape:
    """Verify the migration response model shape."""

    def test_migration_item_model(self) -> None:
        from pqdb_api.routes.projects import MigrationItem

        item = MigrationItem(version="005", applied=True)
        assert item.version == "005"
        assert item.applied is True
