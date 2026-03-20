"""Unit tests for vector similarity search (US-060).

Tests similar_to query generation, distance metrics, validation rules,
and schema engine rejection of encrypted vector columns.
"""

from __future__ import annotations

import pytest

from pqdb_api.services.crud import (
    CrudError,
    FilterOp,
    SimilarTo,
    build_select_sql,
    validate_similar_to,
)
from pqdb_api.services.schema_engine import ColumnDefinition

# --- Column metadata fixtures ---

COLUMNS_META: list[dict[str, str]] = [
    {"name": "title", "sensitivity": "plain", "data_type": "text"},
    {"name": "embedding", "sensitivity": "plain", "data_type": "vector(3)"},
    {"name": "secret", "sensitivity": "private", "data_type": "text"},
    {"name": "email", "sensitivity": "searchable", "data_type": "text"},
    {"name": "score", "sensitivity": "plain", "data_type": "real"},
    {"name": "big_embed", "sensitivity": "plain", "data_type": "vector(768)"},
]


class TestSimilarToDataclass:
    """Test SimilarTo construction and defaults."""

    def test_defaults_to_cosine(self) -> None:
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        assert st.distance == "cosine"

    def test_explicit_l2(self) -> None:
        st = SimilarTo(
            column="embedding", vector=[0.1, 0.2, 0.3], limit=5, distance="l2"
        )
        assert st.distance == "l2"

    def test_explicit_inner_product(self) -> None:
        st = SimilarTo(
            column="embedding",
            vector=[0.1, 0.2, 0.3],
            limit=5,
            distance="inner_product",
        )
        assert st.distance == "inner_product"


class TestValidateSimilarTo:
    """Validate similar_to against column metadata."""

    def test_valid_vector_column(self) -> None:
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        validate_similar_to(st, COLUMNS_META)

    def test_rejects_unknown_column(self) -> None:
        st = SimilarTo(column="nonexistent", vector=[0.1, 0.2, 0.3], limit=5)
        with pytest.raises(CrudError, match="Unknown column"):
            validate_similar_to(st, COLUMNS_META)

    def test_rejects_non_vector_column(self) -> None:
        st = SimilarTo(column="title", vector=[0.1, 0.2, 0.3], limit=5)
        with pytest.raises(CrudError, match="not a vector column"):
            validate_similar_to(st, COLUMNS_META)

    def test_rejects_private_column(self) -> None:
        st = SimilarTo(column="secret", vector=[0.1, 0.2], limit=5)
        with pytest.raises(CrudError, match="sensitive"):
            validate_similar_to(st, COLUMNS_META)

    def test_rejects_searchable_column(self) -> None:
        st = SimilarTo(column="email", vector=[0.1, 0.2], limit=5)
        with pytest.raises(CrudError, match="sensitive"):
            validate_similar_to(st, COLUMNS_META)

    def test_rejects_dimension_mismatch(self) -> None:
        st = SimilarTo(column="embedding", vector=[0.1, 0.2], limit=5)
        with pytest.raises(CrudError, match="dimension mismatch"):
            validate_similar_to(st, COLUMNS_META)

    def test_accepts_matching_dimensions(self) -> None:
        st = SimilarTo(column="big_embed", vector=[0.1] * 768, limit=10)
        validate_similar_to(st, COLUMNS_META)

    def test_rejects_invalid_distance_metric(self) -> None:
        st = SimilarTo(
            column="embedding",
            vector=[0.1, 0.2, 0.3],
            limit=5,
            distance="hamming",
        )
        with pytest.raises(CrudError, match="Unsupported distance"):
            validate_similar_to(st, COLUMNS_META)

    def test_rejects_non_plain_real_column(self) -> None:
        """A plain real/float column is not a vector column."""
        st = SimilarTo(column="score", vector=[0.1], limit=5)
        with pytest.raises(CrudError, match="not a vector column"):
            validate_similar_to(st, COLUMNS_META)


class TestBuildSelectSQLWithSimilarTo:
    """Test SQL generation with similar_to parameter."""

    def test_cosine_distance(self) -> None:
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        sql, params = build_select_sql("documents", similar_to=st)
        assert "ORDER BY" in sql.upper()
        assert "<=>" in sql
        assert "LIMIT" in sql.upper()
        assert params["similar_limit"] == 5

    def test_l2_distance(self) -> None:
        st = SimilarTo(
            column="embedding",
            vector=[0.1, 0.2, 0.3],
            limit=5,
            distance="l2",
        )
        sql, params = build_select_sql("documents", similar_to=st)
        assert "<->" in sql

    def test_inner_product_distance(self) -> None:
        st = SimilarTo(
            column="embedding",
            vector=[0.1, 0.2, 0.3],
            limit=5,
            distance="inner_product",
        )
        sql, params = build_select_sql("documents", similar_to=st)
        assert "<#>" in sql

    def test_similar_to_with_filters(self) -> None:
        """similar_to can be combined with WHERE filters (pre-filtering)."""
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        sql, params = build_select_sql(
            "documents",
            filters=[("title", FilterOp.EQ, "hello")],
            similar_to=st,
        )
        assert "WHERE" in sql.upper()
        assert "ORDER BY" in sql.upper()
        assert "<=>" in sql

    def test_similar_to_overrides_limit(self) -> None:
        """similar_to.limit is used instead of modifiers.limit."""
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        sql, params = build_select_sql("documents", similar_to=st, limit=100)
        # The similar_to limit takes precedence
        assert params["similar_limit"] == 5

    def test_similar_to_cannot_combine_with_order_by(self) -> None:
        """similar_to cannot be combined with explicit order_by."""
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        with pytest.raises(CrudError, match="cannot be combined with order_by"):
            build_select_sql(
                "documents",
                order_by=[("title", "asc")],
                similar_to=st,
            )

    def test_backward_compatible_without_similar_to(self) -> None:
        """Without similar_to, select works identically to Phase 1/2."""
        sql, params = build_select_sql("documents")
        assert "SELECT *" in sql
        assert "<=>" not in sql
        assert "<->" not in sql

    def test_vector_formatted_as_pgvector_literal(self) -> None:
        """Vector values are formatted as pgvector string literals."""
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        sql, params = build_select_sql("documents", similar_to=st)
        assert "similar_vec" in params
        assert params["similar_vec"] == "[0.1,0.2,0.3]"

    def test_select_columns_with_similar_to(self) -> None:
        """Can select specific columns with similar_to."""
        st = SimilarTo(column="embedding", vector=[0.1, 0.2, 0.3], limit=5)
        sql, params = build_select_sql(
            "documents",
            columns=["title", "embedding"],
            similar_to=st,
        )
        assert "title" in sql
        assert "embedding" in sql


class TestSchemaEngineRejectsEncryptedVectors:
    """Schema engine must reject vector(N) columns with non-plain sensitivity."""

    def test_vector_plain_allowed(self) -> None:
        col = ColumnDefinition(
            name="embedding", data_type="vector(3)", sensitivity="plain"
        )
        assert col.data_type == "vector(3)"

    def test_vector_searchable_rejected(self) -> None:
        pattern = r"[Vv]ector.*cannot.*sensitive|[Ss]ensitive.*vector"
        with pytest.raises(ValueError, match=pattern):
            ColumnDefinition(
                name="embedding",
                data_type="vector(3)",
                sensitivity="searchable",
            )

    def test_vector_private_rejected(self) -> None:
        pattern = r"[Vv]ector.*cannot.*sensitive|[Ss]ensitive.*vector"
        with pytest.raises(ValueError, match=pattern):
            ColumnDefinition(
                name="embedding",
                data_type="vector(3)",
                sensitivity="private",
            )
