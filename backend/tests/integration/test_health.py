"""Integration tests for health endpoints.

These tests boot the real FastAPI app via TestClient and hit actual endpoints.
Uses real Postgres via shared conftest fixtures.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import _make_platform_app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_platform_app(test_db_url)
    with TestClient(app) as c:
        yield c


def test_health_endpoint_returns_200(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
