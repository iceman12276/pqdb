"""Integration tests for backup stats endpoint (US-107).

Boots the real FastAPI app with a real Postgres database.
Queries pg_stat_archiver for WAL archiving statistics.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.middleware.user_auth import get_current_user
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.introspection import router as introspection_router


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    """Build a test client with introspection router."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        async def _override_project_context() -> ProjectContext:
            return ProjectContext(
                project_id=uuid.uuid4(),
                key_role="service",
                database_name="test",
            )

        async def _override_current_user() -> None:
            return None

        app.dependency_overrides[get_project_session] = _override_get_project_session
        app.dependency_overrides[get_project_context] = _override_project_context
        app.dependency_overrides[get_current_user] = _override_current_user
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(introspection_router)
    app.include_router(db_router)
    with TestClient(app) as c:
        yield c


# ===========================================================================
# Backups (pg_stat_archiver)
# ===========================================================================
class TestBackups:
    """GET /v1/db/catalog/backups — queries pg_stat_archiver."""

    def test_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/backups")
        assert resp.status_code != 404
        assert resp.status_code != 405

    def test_returns_200(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/backups")
        assert resp.status_code == 200

    def test_returns_dict_not_list(self, client: TestClient) -> None:
        """Backup stats is a single row, not a list."""
        resp = client.get("/v1/db/catalog/backups")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)

    def test_response_has_required_fields(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/backups")
        assert resp.status_code == 200
        data = resp.json()
        required_keys = {
            "archived_count",
            "failed_count",
            "last_archived_wal",
            "last_archived_time",
            "last_failed_wal",
            "last_failed_time",
        }
        assert required_keys.issubset(data.keys())

    def test_archived_count_is_integer(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/backups")
        data = resp.json()
        assert isinstance(data["archived_count"], int)

    def test_failed_count_is_integer(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/backups")
        data = resp.json()
        assert isinstance(data["failed_count"], int)

    def test_nullable_fields_are_string_or_none(self, client: TestClient) -> None:
        """WAL names and timestamps can be null if archiving isn't active."""
        resp = client.get("/v1/db/catalog/backups")
        data = resp.json()
        for field in [
            "last_archived_wal",
            "last_archived_time",
            "last_failed_wal",
            "last_failed_time",
        ]:
            assert data[field] is None or isinstance(data[field], str)
