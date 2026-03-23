"""Unit tests for scoped API key functionality.

Tests permissions schema validation, scoped key generation format,
and the service layer for creating scoped keys.
"""

import re

from pqdb_api.services.api_keys import generate_api_key, validate_permissions


class TestScopedKeyGeneration:
    """Tests for pqdb_scoped_{random} key format."""

    def test_scoped_key_format(self) -> None:
        key = generate_api_key("scoped")
        assert key.startswith("pqdb_scoped_")
        parts = key.split("_", 2)
        assert len(parts) == 3
        assert parts[0] == "pqdb"
        assert parts[1] == "scoped"
        assert len(parts[2]) == 32

    def test_scoped_key_contains_only_url_safe_chars(self) -> None:
        key = generate_api_key("scoped")
        random_part = key.split("_", 2)[2]
        assert re.match(r"^[A-Za-z0-9_-]+$", random_part)

    def test_scoped_keys_are_unique(self) -> None:
        keys = {generate_api_key("scoped") for _ in range(10)}
        assert len(keys) == 10

    def test_scoped_key_prefix_is_first_8_chars(self) -> None:
        key = generate_api_key("scoped")
        assert key[:8] == "pqdb_sco"


class TestValidatePermissions:
    """Tests for permissions schema validation."""

    def test_valid_single_table_single_op(self) -> None:
        perms = {"tables": {"users": ["select"]}}
        assert validate_permissions(perms) is None

    def test_valid_single_table_all_ops(self) -> None:
        perms = {"tables": {"users": ["select", "insert", "update", "delete"]}}
        assert validate_permissions(perms) is None

    def test_valid_multiple_tables(self) -> None:
        perms = {
            "tables": {
                "users": ["select"],
                "posts": ["select", "insert"],
                "comments": ["select", "insert", "update", "delete"],
            }
        }
        assert validate_permissions(perms) is None

    def test_invalid_missing_tables_key(self) -> None:
        perms = {"something": {"users": ["select"]}}
        error = validate_permissions(perms)
        assert error is not None
        assert "tables" in error.lower()

    def test_invalid_tables_not_dict(self) -> None:
        perms = {"tables": "not a dict"}
        error = validate_permissions(perms)
        assert error is not None

    def test_invalid_empty_tables(self) -> None:
        perms: object = {"tables": {}}
        error = validate_permissions(perms)
        assert error is not None

    def test_invalid_operations_not_list(self) -> None:
        perms = {"tables": {"users": "select"}}
        error = validate_permissions(perms)
        assert error is not None

    def test_invalid_empty_operations(self) -> None:
        perms: object = {"tables": {"users": []}}
        error = validate_permissions(perms)
        assert error is not None

    def test_invalid_unknown_operation(self) -> None:
        perms = {"tables": {"users": ["select", "drop"]}}
        error = validate_permissions(perms)
        assert error is not None
        assert "drop" in error.lower()

    def test_invalid_duplicate_operations(self) -> None:
        perms = {"tables": {"users": ["select", "select"]}}
        error = validate_permissions(perms)
        assert error is not None
        assert "duplicate" in error.lower()

    def test_invalid_not_a_dict(self) -> None:
        error = validate_permissions("not a dict")
        assert error is not None

    def test_invalid_extra_top_level_keys(self) -> None:
        perms = {"tables": {"users": ["select"]}, "extra": "bad"}
        error = validate_permissions(perms)
        assert error is not None

    def test_invalid_table_name_empty_string(self) -> None:
        perms = {"tables": {"": ["select"]}}
        error = validate_permissions(perms)
        assert error is not None

    def test_invalid_operation_type_not_string(self) -> None:
        perms = {"tables": {"users": [1, 2]}}
        error = validate_permissions(perms)
        assert error is not None


class TestApiKeyModelName:
    """Tests for the name column on the ApiKey model."""

    def test_model_has_name_column(self) -> None:
        from pqdb_api.models.api_key import ApiKey

        columns = {c.name for c in ApiKey.__table__.columns}
        assert "name" in columns

    def test_name_column_is_nullable(self) -> None:
        from pqdb_api.models.api_key import ApiKey

        col = ApiKey.__table__.columns["name"]
        assert col.nullable is True

    def test_name_defaults_to_none(self) -> None:
        import uuid

        from pqdb_api.models.api_key import ApiKey

        api_key = ApiKey(
            id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            key_hash="$argon2id$...",
            key_prefix="pqdb_ano",
            role="anon",
        )
        assert api_key.name is None

    def test_name_can_be_set(self) -> None:
        import uuid

        from pqdb_api.models.api_key import ApiKey

        api_key = ApiKey(
            id=uuid.uuid4(),
            project_id=uuid.uuid4(),
            key_hash="$argon2id$...",
            key_prefix="pqdb_sco",
            role="scoped",
            name="My Read-Only Key",
        )
        assert api_key.name == "My Read-Only Key"
