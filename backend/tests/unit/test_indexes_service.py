"""Unit tests for vector index management service (US-061).

Tests the index name generation, validation logic, and SQL building
without requiring a real database.
"""

from __future__ import annotations

import pytest

from pqdb_api.services.indexes import (
    IndexType,
    DistanceMetric,
    build_create_index_sql,
    build_drop_index_sql,
    generate_index_name,
    validate_index_request,
    IndexError as IdxError,
)


class TestGenerateIndexName:
    """Test auto-generated index naming: idx_{table}_{column}_{type}."""

    def test_hnsw_index_name(self) -> None:
        assert generate_index_name("documents", "embedding", "hnsw") == (
            "idx_documents_embedding_hnsw"
        )

    def test_ivfflat_index_name(self) -> None:
        assert generate_index_name("items", "vec", "ivfflat") == (
            "idx_items_vec_ivfflat"
        )


class TestValidateIndexRequest:
    """Test validation of index creation requests."""

    def test_valid_hnsw_cosine(self) -> None:
        columns_meta = [
            {"name": "embedding", "sensitivity": "plain", "data_type": "vector(3)"},
        ]
        validate_index_request("embedding", IndexType.HNSW, DistanceMetric.COSINE, columns_meta)

    def test_valid_ivfflat_l2(self) -> None:
        columns_meta = [
            {"name": "vec", "sensitivity": "plain", "data_type": "vector(128)"},
        ]
        validate_index_request("vec", IndexType.IVFFLAT, DistanceMetric.L2, columns_meta)

    def test_reject_nonexistent_column(self) -> None:
        columns_meta = [
            {"name": "title", "sensitivity": "plain", "data_type": "text"},
        ]
        with pytest.raises(IdxError, match="not found"):
            validate_index_request("embedding", IndexType.HNSW, DistanceMetric.COSINE, columns_meta)

    def test_reject_non_vector_column(self) -> None:
        columns_meta = [
            {"name": "title", "sensitivity": "plain", "data_type": "text"},
        ]
        with pytest.raises(IdxError, match="not a vector"):
            validate_index_request("title", IndexType.HNSW, DistanceMetric.COSINE, columns_meta)

    def test_reject_non_plain_column(self) -> None:
        columns_meta = [
            {"name": "embedding", "sensitivity": "searchable", "data_type": "vector(3)"},
        ]
        with pytest.raises(IdxError, match="plain"):
            validate_index_request("embedding", IndexType.HNSW, DistanceMetric.COSINE, columns_meta)


class TestBuildCreateIndexSql:
    """Test SQL generation for CREATE INDEX."""

    def test_hnsw_cosine(self) -> None:
        sql = build_create_index_sql(
            "documents", "embedding", IndexType.HNSW, DistanceMetric.COSINE,
        )
        assert "CREATE INDEX" in sql
        assert "idx_documents_embedding_hnsw" in sql
        assert "hnsw" in sql.lower()
        assert "vector_cosine_ops" in sql

    def test_ivfflat_l2(self) -> None:
        sql = build_create_index_sql(
            "items", "vec", IndexType.IVFFLAT, DistanceMetric.L2,
        )
        assert "idx_items_vec_ivfflat" in sql
        assert "ivfflat" in sql.lower()
        assert "vector_l2_ops" in sql

    def test_hnsw_inner_product(self) -> None:
        sql = build_create_index_sql(
            "docs", "emb", IndexType.HNSW, DistanceMetric.INNER_PRODUCT,
        )
        assert "vector_ip_ops" in sql

    def test_ivfflat_cosine(self) -> None:
        sql = build_create_index_sql(
            "docs", "emb", IndexType.IVFFLAT, DistanceMetric.COSINE,
        )
        assert "ivfflat" in sql.lower()
        assert "vector_cosine_ops" in sql
        # IVFFlat should have WITH (lists = ...)
        assert "lists" in sql.lower()


class TestBuildDropIndexSql:
    """Test SQL generation for DROP INDEX."""

    def test_drop_index(self) -> None:
        sql = build_drop_index_sql("idx_documents_embedding_hnsw")
        assert "DROP INDEX" in sql
        assert "idx_documents_embedding_hnsw" in sql
