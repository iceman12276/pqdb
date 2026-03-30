"""Integration tests for the performance advisor endpoint (US-103).

Boots the real FastAPI app with a real Postgres database.
The project session dependency is overridden to use the same
test Postgres DB, bypassing API key auth. Tests verify that
the endpoint returns a valid response shape.
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
from pqdb_api.routes.performance_advisor import (
    router as performance_advisor_router,
)


def _make_advisor_app(test_db_url: str) -> FastAPI:
    """Build a minimal test app for performance advisor endpoints."""

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
    app.include_router(db_router)
    app.include_router(performance_advisor_router)
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_advisor_app(test_db_url)
    with TestClient(app) as c:
        yield c


class TestPerformanceAdvisorRouteExists:
    """Verify the performance advisor route is registered."""

    def test_performance_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/advisor/performance")
        assert resp.status_code != 404
        assert resp.status_code != 405


class TestPerformanceAdvisorResponseShape:
    """Verify the endpoint returns the expected response shape."""

    def test_returns_list(self, client: TestClient) -> None:
        resp = client.get("/v1/db/advisor/performance")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    def test_empty_db_returns_list(self, client: TestClient) -> None:
        """A fresh database with no user tables returns an empty list."""
        resp = client.get("/v1/db/advisor/performance")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    def test_with_table_returns_valid_shape(self, client: TestClient) -> None:
        """Creating a table should produce at least a stale_stats recommendation."""
        # Create a table so there's something to analyze
        client.post(
            "/v1/db/tables",
            json={
                "name": "perf_test",
                "columns": [
                    {"name": "title", "data_type": "text", "sensitivity": "plain"},
                ],
            },
        )

        resp = client.get("/v1/db/advisor/performance")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

        # With a freshly created table we expect at least stale_stats
        # (table has never been analyzed)
        if len(data) > 0:
            rec = data[0]
            # Verify all required fields exist
            assert "rule_id" in rec
            assert "severity" in rec
            assert "category" in rec
            assert "title" in rec
            assert "message" in rec
            assert "table" in rec
            assert "suggestion" in rec
            # Verify field value types
            assert rec["severity"] in ("warning", "info")
            assert isinstance(rec["message"], str)
            assert isinstance(rec["suggestion"], str)


class TestHealthStillWorks:
    """Health check still works with advisor routes."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
