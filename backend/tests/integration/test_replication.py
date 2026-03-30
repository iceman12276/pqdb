"""Integration tests for replication introspection endpoint (US-106).

Boots the real FastAPI app with a real Postgres database.
Tests verify that the replication endpoint returns slot and stat data.
Since test Postgres typically has no replication configured, we expect
empty lists in the default case.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from pqdb_api.routes.introspection import router as introspection_router
from tests.integration.conftest import _make_project_app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_project_app(test_db_url)
    # The introspection router (catalog endpoints) is separate from db_router
    app.include_router(introspection_router)
    with TestClient(app) as c:
        yield c


class TestReplicationRouteExists:
    """Verify the /v1/db/catalog/replication route is registered."""

    def test_replication_route_exists(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/catalog/replication")
        assert resp.status_code != 404
        assert resp.status_code != 405


class TestReplicationEmptyState:
    """Test GET /v1/db/catalog/replication with no replication configured."""

    def test_returns_200(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/catalog/replication")
        assert resp.status_code == 200

    def test_returns_slots_and_stats(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/catalog/replication")
        data = resp.json()
        assert "slots" in data
        assert "stats" in data

    def test_slots_is_empty_list(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/catalog/replication")
        data = resp.json()
        assert isinstance(data["slots"], list)
        assert len(data["slots"]) == 0

    def test_stats_is_empty_list(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get("/v1/db/catalog/replication")
        data = resp.json()
        assert isinstance(data["stats"], list)
        assert len(data["stats"]) == 0
