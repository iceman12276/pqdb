"""Integration tests for vector index management (US-061).

Boots the real FastAPI app with real Postgres + pgvector.
Tests the full lifecycle: create index, list indexes, drop index,
conflict detection, and validation.
"""

from __future__ import annotations

import socket
import subprocess
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import (
    PG_HOST,
    PG_PORT,
    _make_project_app,
)


# ---------------------------------------------------------------------------
# Skip if Postgres not available
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def client(test_db_name: str, test_db_url: str) -> Iterator[TestClient]:
    """Create a test client with pgvector extension and indexes router."""
    from tests.integration.conftest import PG_USER, _pg_env

    subprocess.run(
        [
            "psql",
            "-h",
            PG_HOST,
            "-p",
            str(PG_PORT),
            "-U",
            PG_USER,
            "-d",
            test_db_name,
            "-c",
            "CREATE EXTENSION IF NOT EXISTS vector",
        ],
        env=_pg_env(),
        check=True,
        capture_output=True,
    )

    app = _make_project_app(test_db_url)
    # Also include the indexes router
    from pqdb_api.routes.indexes import router as indexes_router

    app.include_router(indexes_router)

    with TestClient(app) as c:
        yield c


def _create_vector_table(client: TestClient) -> None:
    """Create a table with a vector(3) column for testing."""
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": "documents",
            "columns": [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
                {"name": "embedding", "data_type": "vector(3)", "sensitivity": "plain"},
            ],
        },
    )
    assert resp.status_code == 201, resp.json()


# ---------------------------------------------------------------------------
# Tests: Create Index
# ---------------------------------------------------------------------------
class TestCreateIndex:
    """Test POST /v1/db/tables/{name}/indexes."""

    def test_create_hnsw_index(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "hnsw", "distance": "cosine"},
        )
        assert resp.status_code == 201, resp.json()
        data = resp.json()
        assert data["index_name"] == "idx_documents_embedding_hnsw"
        assert data["type"] == "hnsw"
        assert data["distance"] == "cosine"
        assert data["column"] == "embedding"

    def test_create_ivfflat_index(self, client: TestClient) -> None:
        _create_vector_table(client)
        # Insert enough rows for IVFFlat to work
        rows = [
            {"title": f"doc_{i}", "embedding": f"[{i*0.1},{i*0.2},{i*0.3}]"}
            for i in range(10)
        ]
        client.post("/v1/db/documents/insert", json={"rows": rows})

        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "ivfflat", "distance": "l2"},
        )
        assert resp.status_code == 201, resp.json()
        data = resp.json()
        assert data["index_name"] == "idx_documents_embedding_ivfflat"
        assert data["type"] == "ivfflat"

    def test_default_distance_is_cosine(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "hnsw"},
        )
        assert resp.status_code == 201
        assert resp.json()["distance"] == "cosine"

    def test_409_duplicate_index(self, client: TestClient) -> None:
        _create_vector_table(client)
        client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "hnsw", "distance": "cosine"},
        )
        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "hnsw", "distance": "cosine"},
        )
        assert resp.status_code == 409
        assert "already exists" in resp.json()["detail"]

    def test_400_non_vector_column(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "title", "type": "hnsw", "distance": "cosine"},
        )
        assert resp.status_code == 400
        assert "not a vector" in resp.json()["detail"]

    def test_400_nonexistent_column(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "nonexistent", "type": "hnsw"},
        )
        assert resp.status_code == 400
        assert "not found" in resp.json()["detail"]

    def test_404_nonexistent_table(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables/nonexistent/indexes",
            json={"column": "emb", "type": "hnsw"},
        )
        assert resp.status_code == 404

    def test_422_invalid_type(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "btree"},
        )
        assert resp.status_code == 422

    def test_422_invalid_distance(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "hnsw", "distance": "hamming"},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Tests: List Indexes
# ---------------------------------------------------------------------------
class TestListIndexes:
    """Test GET /v1/db/tables/{name}/indexes."""

    def test_list_empty(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.get("/v1/db/tables/documents/indexes")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_after_create(self, client: TestClient) -> None:
        _create_vector_table(client)
        client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "hnsw", "distance": "cosine"},
        )
        resp = client.get("/v1/db/tables/documents/indexes")
        assert resp.status_code == 200
        indexes = resp.json()
        assert len(indexes) == 1
        assert indexes[0]["index_name"] == "idx_documents_embedding_hnsw"
        assert indexes[0]["type"] == "hnsw"
        assert indexes[0]["distance"] == "cosine"
        assert indexes[0]["column"] == "embedding"

    def test_404_nonexistent_table(self, client: TestClient) -> None:
        resp = client.get("/v1/db/tables/nonexistent/indexes")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Drop Index
# ---------------------------------------------------------------------------
class TestDropIndex:
    """Test DELETE /v1/db/tables/{name}/indexes/{index_name}."""

    def test_drop_existing_index(self, client: TestClient) -> None:
        _create_vector_table(client)
        client.post(
            "/v1/db/tables/documents/indexes",
            json={"column": "embedding", "type": "hnsw", "distance": "cosine"},
        )
        resp = client.delete(
            "/v1/db/tables/documents/indexes/idx_documents_embedding_hnsw"
        )
        assert resp.status_code == 204

        # Verify it's gone
        resp = client.get("/v1/db/tables/documents/indexes")
        assert resp.json() == []

    def test_404_nonexistent_index(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.delete(
            "/v1/db/tables/documents/indexes/idx_documents_embedding_hnsw"
        )
        assert resp.status_code == 404

    def test_400_wrong_table_prefix(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.delete(
            "/v1/db/tables/documents/indexes/idx_other_embedding_hnsw"
        )
        assert resp.status_code == 400
        assert "does not belong" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Tests: Health
# ---------------------------------------------------------------------------
class TestIndexesHealth:
    """Verify service health check still works with indexes router."""

    def test_health_endpoint(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
