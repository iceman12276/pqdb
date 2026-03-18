"""Unit tests for the Developer model."""

import uuid

from pqdb_api.models.developer import Developer


class TestDeveloperModel:
    """Tests for Developer SQLAlchemy model."""

    def test_table_name(self) -> None:
        assert Developer.__tablename__ == "developers"

    def test_columns_exist(self) -> None:
        columns = {c.name for c in Developer.__table__.columns}
        expected = {"id", "email", "password_hash", "email_verified", "created_at"}
        assert columns == expected

    def test_id_is_primary_key(self) -> None:
        pk_cols = [c.name for c in Developer.__table__.primary_key]
        assert pk_cols == ["id"]

    def test_email_is_unique(self) -> None:
        email_col = Developer.__table__.columns["email"]
        assert email_col.unique is True

    def test_can_instantiate(self) -> None:
        dev_id = uuid.uuid4()
        dev = Developer(
            id=dev_id,
            email="test@example.com",
            password_hash="$argon2id$v=19$m=65536...",
        )
        assert dev.id == dev_id
        assert dev.email == "test@example.com"
