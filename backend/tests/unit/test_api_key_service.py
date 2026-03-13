"""Unit tests for the API key service."""

import re

from pqdb_api.services.api_keys import generate_api_key, hash_api_key


class TestGenerateApiKey:
    """Tests for API key generation."""

    def test_anon_key_format(self) -> None:
        key = generate_api_key("anon")
        assert key.startswith("pqdb_anon_")
        parts = key.split("_", 2)
        assert len(parts) == 3
        assert parts[0] == "pqdb"
        assert parts[1] == "anon"
        assert len(parts[2]) == 32

    def test_service_key_format(self) -> None:
        key = generate_api_key("service")
        assert key.startswith("pqdb_service_")
        parts = key.split("_", 2)
        assert len(parts) == 3
        assert parts[0] == "pqdb"
        assert parts[1] == "service"
        assert len(parts[2]) == 32

    def test_key_contains_only_url_safe_chars(self) -> None:
        key = generate_api_key("anon")
        random_part = key.split("_", 2)[2]
        assert re.match(r"^[A-Za-z0-9_-]+$", random_part)

    def test_keys_are_unique(self) -> None:
        keys = {generate_api_key("anon") for _ in range(10)}
        assert len(keys) == 10

    def test_key_prefix_is_first_8_chars(self) -> None:
        key = generate_api_key("anon")
        assert key[:8] == "pqdb_ano"

    def test_service_key_prefix_is_first_8_chars(self) -> None:
        key = generate_api_key("service")
        assert key[:8] == "pqdb_ser"


class TestHashApiKey:
    """Tests for API key hashing."""

    def test_hash_returns_string(self) -> None:
        key = generate_api_key("anon")
        hashed = hash_api_key(key)
        assert isinstance(hashed, str)

    def test_hash_contains_argon2id_marker(self) -> None:
        key = generate_api_key("anon")
        hashed = hash_api_key(key)
        assert "$argon2id$" in hashed

    def test_hash_is_different_from_key(self) -> None:
        key = generate_api_key("anon")
        hashed = hash_api_key(key)
        assert hashed != key

    def test_same_key_produces_different_hashes(self) -> None:
        key = generate_api_key("anon")
        h1 = hash_api_key(key)
        h2 = hash_api_key(key)
        assert h1 != h2  # argon2id uses random salt
