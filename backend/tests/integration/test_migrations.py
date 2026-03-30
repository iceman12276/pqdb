"""Integration tests for the migrations endpoint.

Uses real Postgres to verify the endpoint returns migration data
from Alembic migration files and the alembic_version table.
"""

import socket

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import (
    _make_platform_app,
    auth_headers,
    create_project,
    signup_and_get_token,
)

PG_HOST = "localhost"
PG_PORT = 5432


def _pg_available() -> bool:
    try:
        with socket.create_connection((PG_HOST, PG_PORT), timeout=2):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_available(),
    reason="Integration tests require Postgres on localhost:5432",
)


class TestMigrationsEndpoint:
    """Verify GET /v1/projects/{id}/migrations returns migration data."""

    def test_returns_migration_list(self, test_db_url: str) -> None:
        """Endpoint should list Alembic migration files."""
        from pqdb_api.routes.migrations import router as migrations_router

        app = _make_platform_app(test_db_url)
        app.include_router(migrations_router)

        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)
            project_id = project["id"]

            resp = client.get(
                f"/v1/projects/{project_id}/migrations",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()

            # Should have the expected shape
            assert "current_head" in data
            assert "migrations" in data
            assert isinstance(data["migrations"], list)

            # Should have at least 1 migration (from real Alembic files)
            assert len(data["migrations"]) >= 1

            # First migration should be revision 001
            first = data["migrations"][0]
            assert first["revision"] == "001"
            assert first["down_revision"] is None
            assert "description" in first
            assert isinstance(first["applied"], bool)

    def test_requires_auth(self, test_db_url: str) -> None:
        """Endpoint should reject unauthenticated requests."""
        from pqdb_api.routes.migrations import router as migrations_router

        app = _make_platform_app(test_db_url)
        app.include_router(migrations_router)

        with TestClient(app) as client:
            resp = client.get("/v1/projects/some-id/migrations")
            assert resp.status_code in (401, 403, 422)

    def test_migration_entries_have_required_fields(self, test_db_url: str) -> None:
        """Each migration entry should have revision, down_revision, description, applied."""
        from pqdb_api.routes.migrations import router as migrations_router

        app = _make_platform_app(test_db_url)
        app.include_router(migrations_router)

        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)

            resp = client.get(
                f"/v1/projects/{project['id']}/migrations",
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            data = resp.json()

            for entry in data["migrations"]:
                assert "revision" in entry
                assert "down_revision" in entry
                assert "description" in entry
                assert "applied" in entry

    def test_migrations_ordered_by_revision(self, test_db_url: str) -> None:
        """Migration entries should be sorted by filename (revision order)."""
        from pqdb_api.routes.migrations import router as migrations_router

        app = _make_platform_app(test_db_url)
        app.include_router(migrations_router)

        with TestClient(app) as client:
            token = signup_and_get_token(client)
            project = create_project(client, token)

            resp = client.get(
                f"/v1/projects/{project['id']}/migrations",
                headers=auth_headers(token),
            )
            data = resp.json()
            revisions = [m["revision"] for m in data["migrations"]]
            assert revisions == sorted(revisions)
