"""Unit tests for the ApiKey model."""

import uuid

from pqdb_api.models.api_key import ApiKey


class TestApiKeyModel:
    """Tests for ApiKey SQLAlchemy model."""

    def test_table_name(self) -> None:
        assert ApiKey.__tablename__ == "api_keys"

    def test_columns_exist(self) -> None:
        columns = {c.name for c in ApiKey.__table__.columns}
        expected = {
            "id",
            "project_id",
            "key_hash",
            "key_prefix",
            "role",
            "created_at",
        }
        assert columns == expected

    def test_id_is_primary_key(self) -> None:
        pk_cols = [c.name for c in ApiKey.__table__.primary_key]
        assert pk_cols == ["id"]

    def test_project_id_is_foreign_key(self) -> None:
        col = ApiKey.__table__.columns["project_id"]
        fk_targets = [fk.target_fullname for fk in col.foreign_keys]
        assert "projects.id" in fk_targets

    def test_key_hash_is_not_nullable(self) -> None:
        col = ApiKey.__table__.columns["key_hash"]
        assert col.nullable is False

    def test_key_prefix_is_not_nullable(self) -> None:
        col = ApiKey.__table__.columns["key_prefix"]
        assert col.nullable is False

    def test_role_is_not_nullable(self) -> None:
        col = ApiKey.__table__.columns["role"]
        assert col.nullable is False

    def test_can_instantiate(self) -> None:
        key_id = uuid.uuid4()
        proj_id = uuid.uuid4()
        api_key = ApiKey(
            id=key_id,
            project_id=proj_id,
            key_hash="$argon2id$...",
            key_prefix="pqdb_ano",
            role="anon",
        )
        assert api_key.id == key_id
        assert api_key.project_id == proj_id
        assert api_key.key_hash == "$argon2id$..."
        assert api_key.key_prefix == "pqdb_ano"
        assert api_key.role == "anon"
