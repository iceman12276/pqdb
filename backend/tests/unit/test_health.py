"""Unit tests for health endpoints."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from pqdb_api.routes.health import router


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_response_content_type(client: TestClient) -> None:
    response = client.get("/health")
    assert response.headers["content-type"] == "application/json"
