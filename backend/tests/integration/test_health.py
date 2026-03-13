"""Integration tests for health endpoints.

These tests boot the real FastAPI app via TestClient and hit actual endpoints.
"""

import pytest
from fastapi.testclient import TestClient

from pqdb_api.app import create_app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


def test_health_endpoint_returns_200(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_endpoint_returns_503_without_db(client: TestClient) -> None:
    """Without a running Postgres, /ready should return 503."""
    response = client.get("/ready")
    assert response.status_code == 503
    data = response.json()
    assert data["status"] == "unavailable"
