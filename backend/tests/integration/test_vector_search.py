"""Integration tests for vector similarity search (US-060).

Boots the real FastAPI app with real Postgres + pgvector.
Tests the full workflow: create table with vector column, insert vectors,
similarity query, and correct top-K results.
"""

from __future__ import annotations

import socket
import subprocess
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import PG_HOST, PG_PORT, _make_project_app


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
    """Create a test client and ensure pgvector extension is enabled."""
    # Enable pgvector extension in the test database
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
    with TestClient(app) as c:
        yield c


def _create_vector_table(client: TestClient) -> None:
    """Create a table with a vector(3) column."""
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": "documents",
            "columns": [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
                {"name": "embedding", "data_type": "vector(3)", "sensitivity": "plain"},
                {"name": "category", "data_type": "text", "sensitivity": "plain"},
            ],
        },
    )
    assert resp.status_code == 201, resp.json()


def _insert_vectors(client: TestClient) -> None:
    """Insert test documents with known embedding vectors."""
    # Vectors chosen so cosine distance is predictable:
    # [1, 0, 0] is closest to [0.9, 0.1, 0]
    resp = client.post(
        "/v1/db/documents/insert",
        json={
            "rows": [
                {"title": "doc_a", "embedding": "[1,0,0]", "category": "science"},
                {"title": "doc_b", "embedding": "[0,1,0]", "category": "art"},
                {"title": "doc_c", "embedding": "[0,0,1]", "category": "science"},
                {"title": "doc_d", "embedding": "[0.9,0.1,0]", "category": "science"},
                {"title": "doc_e", "embedding": "[0.1,0.9,0]", "category": "art"},
            ],
        },
    )
    assert resp.status_code == 201, resp.json()


# ---------------------------------------------------------------------------
# Tests: Table creation with vector columns
# ---------------------------------------------------------------------------
class TestVectorTableCreation:
    """Test creating tables with vector columns."""

    def test_create_table_with_vector_column(self, client: TestClient) -> None:
        _create_vector_table(client)
        resp = client.get("/v1/db/tables/documents")
        assert resp.status_code == 200
        data = resp.json()
        emb_col = next(c for c in data["columns"] if c["name"] == "embedding")
        assert emb_col["data_type"] == "vector(3)"
        assert emb_col["sensitivity"] == "plain"

    def test_reject_searchable_vector_column(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "bad_table",
                "columns": [
                    {
                        "name": "emb",
                        "data_type": "vector(3)",
                        "sensitivity": "searchable",
                    },
                ],
            },
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"].lower()
        assert "vector" in detail or "sensitive" in detail

    def test_reject_private_vector_column(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "bad_table2",
                "columns": [
                    {"name": "emb", "data_type": "vector(3)", "sensitivity": "private"},
                ],
            },
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Tests: Vector similarity search
# ---------------------------------------------------------------------------
class TestVectorSimilaritySearch:
    """Test POST /{table}/select with similar_to."""

    def test_cosine_similarity_top_k(self, client: TestClient) -> None:
        """Insert vectors, query with similar_to, verify top-K ordering."""
        _create_vector_table(client)
        _insert_vectors(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "embedding",
                    "vector": [1.0, 0.0, 0.0],
                    "limit": 3,
                },
            },
        )
        assert resp.status_code == 200, resp.json()
        data = resp.json()["data"]
        assert len(data) == 3
        # First result should be doc_a (exact match [1,0,0])
        # Second should be doc_d ([0.9,0.1,0] — very close)
        titles = [r["title"] for r in data]
        assert titles[0] == "doc_a"
        assert titles[1] == "doc_d"

    def test_l2_distance(self, client: TestClient) -> None:
        _create_vector_table(client)
        _insert_vectors(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "embedding",
                    "vector": [1.0, 0.0, 0.0],
                    "limit": 2,
                    "distance": "l2",
                },
            },
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 2
        assert data[0]["title"] == "doc_a"

    def test_inner_product_distance(self, client: TestClient) -> None:
        _create_vector_table(client)
        _insert_vectors(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "embedding",
                    "vector": [1.0, 0.0, 0.0],
                    "limit": 2,
                    "distance": "inner_product",
                },
            },
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 2

    def test_similar_to_with_filters(self, client: TestClient) -> None:
        """Pre-filter by category, then vector search within results."""
        _create_vector_table(client)
        _insert_vectors(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "filters": [{"column": "category", "op": "eq", "value": "science"}],
                "similar_to": {
                    "column": "embedding",
                    "vector": [1.0, 0.0, 0.0],
                    "limit": 5,
                },
            },
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        # Only science docs: doc_a, doc_c, doc_d
        assert len(data) == 3
        categories = {r["category"] for r in data}
        assert categories == {"science"}

    def test_backward_compatible_without_similar_to(self, client: TestClient) -> None:
        """Select without similar_to works identically to Phase 1/2."""
        _create_vector_table(client)
        _insert_vectors(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={},
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 5


# ---------------------------------------------------------------------------
# Tests: Validation errors
# ---------------------------------------------------------------------------
class TestVectorValidation:
    """Test validation rules for similar_to."""

    def test_reject_dimension_mismatch(self, client: TestClient) -> None:
        _create_vector_table(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "embedding",
                    "vector": [0.1, 0.2],  # 2 dims, column is 3
                    "limit": 5,
                },
            },
        )
        assert resp.status_code == 400
        assert "dimension" in resp.json()["detail"].lower()

    def test_reject_non_vector_column(self, client: TestClient) -> None:
        _create_vector_table(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "title",
                    "vector": [0.1, 0.2, 0.3],
                    "limit": 5,
                },
            },
        )
        assert resp.status_code == 400
        assert "not a vector column" in resp.json()["detail"]

    def test_reject_unknown_column(self, client: TestClient) -> None:
        _create_vector_table(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "nonexistent",
                    "vector": [0.1, 0.2, 0.3],
                    "limit": 5,
                },
            },
        )
        assert resp.status_code == 400
        assert "unknown" in resp.json()["detail"].lower()

    def test_reject_invalid_distance_metric(self, client: TestClient) -> None:
        _create_vector_table(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "embedding",
                    "vector": [0.1, 0.2, 0.3],
                    "limit": 5,
                    "distance": "hamming",
                },
            },
        )
        assert resp.status_code == 422  # Pydantic validation

    def test_reject_similar_to_with_order_by(self, client: TestClient) -> None:
        _create_vector_table(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "modifiers": {"order_by": "title"},
                "similar_to": {
                    "column": "embedding",
                    "vector": [0.1, 0.2, 0.3],
                    "limit": 5,
                },
            },
        )
        assert resp.status_code == 400
        assert "order_by" in resp.json()["detail"]

    def test_similar_to_requires_limit(self, client: TestClient) -> None:
        _create_vector_table(client)

        resp = client.post(
            "/v1/db/documents/select",
            json={
                "similar_to": {
                    "column": "embedding",
                    "vector": [0.1, 0.2, 0.3],
                    # no limit field
                },
            },
        )
        assert resp.status_code == 422  # Pydantic validation (limit is required)


# ---------------------------------------------------------------------------
# Tests: Health check
# ---------------------------------------------------------------------------
class TestHealthWithVector:
    """Verify service health check still works."""

    def test_health_endpoint(self, client: TestClient) -> None:
        resp = client.get("/v1/db/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
