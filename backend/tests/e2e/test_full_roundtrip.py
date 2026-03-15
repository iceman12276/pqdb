"""E2E tests — full round-trip with real Postgres + real Vault.

Every test boots the real FastAPI app (create_app), connects to real
Postgres for the platform DB and provisioned project databases, and
uses real Vault for HMAC key storage.
"""

from __future__ import annotations

import hashlib
import hmac
import os

import asyncpg
import pytest
from httpx import AsyncClient

from tests.e2e.conftest import (
    auth_headers,
    create_project_and_get_keys,
    signup_and_get_token,
)

pytestmark = [pytest.mark.asyncio]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_ciphertext(plaintext: str) -> str:
    """Simulate client-side encryption: produce opaque hex bytes.

    In the real SDK, this would be ML-KEM-768 encryption.
    For E2E testing we just need opaque bytes the server stores as-is.
    The plaintext is NOT included — the output is fully opaque.
    """
    # Use HMAC to produce deterministic-looking but opaque output
    # so the same plaintext always produces different ciphertext (via random salt).
    salt = os.urandom(16)
    return (salt + hashlib.sha256(plaintext.encode() + salt).digest()).hex()


def _blind_index(value: str, hmac_key: bytes) -> str:
    """Compute an HMAC-SHA3-256 blind index, matching the SDK algorithm."""
    return hmac.new(hmac_key, value.encode(), hashlib.sha3_256).hexdigest()


async def _setup_platform_flow(
    client: AsyncClient,
) -> tuple[str, str, list[dict[str, str]], str | None]:
    """Sign up, create project, return (token, project_id, keys, db_name)."""
    token = await signup_and_get_token(client, email="e2e@test.com")
    project_id, keys, db_name = await create_project_and_get_keys(
        client, token, name="e2e-project"
    )
    return token, project_id, keys, db_name


def _get_anon_key(keys: list[dict[str, str]]) -> str:
    return next(k["key"] for k in keys if k["role"] == "anon")


def _get_service_key(keys: list[dict[str, str]]) -> str:
    return next(k["key"] for k in keys if k["role"] == "service")


# ---------------------------------------------------------------------------
# Test 1: Platform flow
# ---------------------------------------------------------------------------


class TestPlatformFlow:
    """Signup -> create project -> get API keys (real Postgres)."""

    @pytest.mark.asyncio
    async def test_signup_create_project_get_keys(self, client: AsyncClient) -> None:
        # 1. Signup
        token = await signup_and_get_token(client, email="platform@e2e.com")
        assert token

        # 2. Create project
        project_id, keys, db_name = await create_project_and_get_keys(
            client, token, name="platform-e2e"
        )
        assert project_id
        assert db_name is not None, "Project database should be provisioned"
        assert db_name.startswith("pqdb_project_")

        # 3. API keys returned
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}

        # 4. Both keys work
        anon_key = _get_anon_key(keys)
        resp = await client.get("/v1/db/health", headers={"apikey": anon_key})
        assert resp.status_code == 200
        assert resp.json()["project_id"] == project_id

        service_key = _get_service_key(keys)
        resp = await client.get("/v1/db/health", headers={"apikey": service_key})
        assert resp.status_code == 200

        # 5. HMAC key retrievable from Vault (versioned format)
        resp = await client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        hmac_data = resp.json()
        assert "current_version" in hmac_data
        assert "keys" in hmac_data
        current_key = hmac_data["keys"][str(hmac_data["current_version"])]
        assert len(bytes.fromhex(current_key)) == 32


# ---------------------------------------------------------------------------
# Test 2: Schema flow
# ---------------------------------------------------------------------------


class TestSchemaFlow:
    """Create table with mixed sensitivity -> introspect -> verify shadow columns."""

    @pytest.mark.asyncio
    async def test_create_table_and_introspect(self, client: AsyncClient) -> None:
        token, project_id, keys, db_name = await _setup_platform_flow(client)
        anon_key = _get_anon_key(keys)
        api_headers: dict[str, str] = {"apikey": anon_key}

        # Create table with mixed sensitivity
        resp = await client.post(
            "/v1/db/tables",
            headers=api_headers,
            json={
                "name": "contacts",
                "columns": [
                    {
                        "name": "display_name",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {
                        "name": "email",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                    {
                        "name": "ssn",
                        "data_type": "text",
                        "sensitivity": "private",
                    },
                    {
                        "name": "age",
                        "data_type": "integer",
                        "sensitivity": "plain",
                    },
                ],
            },
        )
        assert resp.status_code == 201, resp.text
        schema = resp.json()
        assert schema["name"] == "contacts"

        # Introspect
        resp = await client.get(
            "/v1/db/tables/contacts",
            headers=api_headers,
        )
        assert resp.status_code == 200
        table_info = resp.json()
        col_map = {c["name"]: c for c in table_info["columns"]}

        assert col_map["display_name"]["sensitivity"] == "plain"
        assert col_map["email"]["sensitivity"] == "searchable"
        assert col_map["ssn"]["sensitivity"] == "private"
        assert col_map["age"]["sensitivity"] == "plain"

        # Verify physical columns exist in the real project DB
        conn = await asyncpg.connect(
            f"postgresql://postgres:postgres@localhost:5432/{db_name}"
        )
        try:
            columns = await conn.fetch(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'contacts' ORDER BY ordinal_position"
            )
            col_names = {r["column_name"] for r in columns}
            # Plain columns exist directly
            assert "display_name" in col_names
            assert "age" in col_names
            # Searchable: _encrypted + _index
            assert "email_encrypted" in col_names
            assert "email_index" in col_names
            # Private: _encrypted only
            assert "ssn_encrypted" in col_names
            # Original sensitive names should NOT exist
            assert "email" not in col_names
            assert "ssn" not in col_names
        finally:
            await conn.close()


# ---------------------------------------------------------------------------
# Test 3: Insert + Select with blind index
# ---------------------------------------------------------------------------


class TestInsertSelect:
    """Insert with encrypted shadow columns -> select with blind index."""

    @pytest.mark.asyncio
    async def test_insert_and_select_by_blind_index(self, client: AsyncClient) -> None:
        token, project_id, keys, db_name = await _setup_platform_flow(client)
        anon_key = _get_anon_key(keys)
        api_headers: dict[str, str] = {"apikey": anon_key}

        # Get HMAC key from Vault (versioned format)
        resp = await client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        hmac_data = resp.json()
        hmac_key = bytes.fromhex(hmac_data["keys"][str(hmac_data["current_version"])])

        # Create table
        resp = await client.post(
            "/v1/db/tables",
            headers=api_headers,
            json={
                "name": "users",
                "columns": [
                    {
                        "name": "display_name",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {
                        "name": "email",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                    {
                        "name": "ssn",
                        "data_type": "text",
                        "sensitivity": "private",
                    },
                    {
                        "name": "age",
                        "data_type": "integer",
                        "sensitivity": "plain",
                    },
                ],
            },
        )
        assert resp.status_code == 201

        # Insert two rows with simulated encryption + blind index
        alice_email_ct = _fake_ciphertext("alice@example.com")
        alice_email_idx = _blind_index("alice@example.com", hmac_key)
        alice_ssn_ct = _fake_ciphertext("123-45-6789")

        bob_email_ct = _fake_ciphertext("bob@example.com")
        bob_email_idx = _blind_index("bob@example.com", hmac_key)
        bob_ssn_ct = _fake_ciphertext("987-65-4321")

        resp = await client.post(
            "/v1/db/users/insert",
            headers=api_headers,
            json={
                "rows": [
                    {
                        "display_name": "Alice",
                        "email": alice_email_ct,
                        "email_index": alice_email_idx,
                        "ssn": alice_ssn_ct,
                        "age": 30,
                    },
                    {
                        "display_name": "Bob",
                        "email": bob_email_ct,
                        "email_index": bob_email_idx,
                        "ssn": bob_ssn_ct,
                        "age": 25,
                    },
                ]
            },
        )
        assert resp.status_code == 201, resp.text
        inserted = resp.json()["data"]
        assert len(inserted) == 2

        # Select by blind index (searchable column)
        resp = await client.post(
            "/v1/db/users/select",
            headers=api_headers,
            json={
                "filters": [{"column": "email", "op": "eq", "value": alice_email_idx}]
            },
        )
        assert resp.status_code == 200
        found = resp.json()["data"]
        assert len(found) == 1
        assert found[0]["display_name"] == "Alice"
        assert found[0]["email_encrypted"] == alice_email_ct
        assert found[0]["email_index"] == alice_email_idx


# ---------------------------------------------------------------------------
# Test 4: Zero-knowledge verification
# ---------------------------------------------------------------------------


class TestZeroKnowledge:
    """Directly query the project DB to verify no plaintext exists."""

    @pytest.mark.asyncio
    async def test_no_plaintext_in_database(self, client: AsyncClient) -> None:
        token, project_id, keys, db_name = await _setup_platform_flow(client)
        anon_key = _get_anon_key(keys)
        api_headers: dict[str, str] = {"apikey": anon_key}

        # Get HMAC key (versioned format)
        resp = await client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        hmac_data = resp.json()
        hmac_key = bytes.fromhex(hmac_data["keys"][str(hmac_data["current_version"])])

        # Create table + insert
        await client.post(
            "/v1/db/tables",
            headers=api_headers,
            json={
                "name": "secrets",
                "columns": [
                    {
                        "name": "label",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {
                        "name": "email",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                    {
                        "name": "ssn",
                        "data_type": "text",
                        "sensitivity": "private",
                    },
                ],
            },
        )

        email_plaintext = "secret@example.com"
        ssn_plaintext = "111-22-3333"
        email_ct = _fake_ciphertext(email_plaintext)
        email_idx = _blind_index(email_plaintext, hmac_key)
        ssn_ct = _fake_ciphertext(ssn_plaintext)

        resp = await client.post(
            "/v1/db/secrets/insert",
            headers=api_headers,
            json={
                "rows": [
                    {
                        "label": "test-row",
                        "email": email_ct,
                        "email_index": email_idx,
                        "ssn": ssn_ct,
                    }
                ]
            },
        )
        assert resp.status_code == 201

        # Directly query the project database — bypass the API
        conn = await asyncpg.connect(
            f"postgresql://postgres:postgres@localhost:5432/{db_name}"
        )
        try:
            rows = await conn.fetch("SELECT * FROM secrets")
            assert len(rows) == 1
            row = dict(rows[0])

            # Plain column is stored as-is
            assert row["label"] == "test-row"

            # Encrypted columns contain ciphertext as bytea, NOT plaintext.
            # asyncpg returns bytea as bytes; the API stored the string
            # encoded as UTF-8.
            email_encrypted_raw = row["email_encrypted"]
            ssn_encrypted_raw = row["ssn_encrypted"]

            assert email_encrypted_raw == email_ct.encode("utf-8")
            assert email_plaintext.encode("utf-8") not in email_encrypted_raw

            assert ssn_encrypted_raw == ssn_ct.encode("utf-8")
            assert ssn_plaintext.encode("utf-8") not in ssn_encrypted_raw

            # Index column contains HMAC hash, NOT plaintext
            assert row["email_index"] == email_idx
            assert email_plaintext != row["email_index"]

            # Original column names should NOT exist
            assert "email" not in row
            assert "ssn" not in row
        finally:
            await conn.close()


# ---------------------------------------------------------------------------
# Test 5: Update + Delete
# ---------------------------------------------------------------------------


class TestUpdateDelete:
    """Update via blind index -> verify changed ciphertext -> delete -> verify gone."""

    @pytest.mark.asyncio
    async def test_update_and_delete_via_blind_index(self, client: AsyncClient) -> None:
        token, project_id, keys, db_name = await _setup_platform_flow(client)
        anon_key = _get_anon_key(keys)
        api_headers: dict[str, str] = {"apikey": anon_key}

        # Get HMAC key (versioned format)
        resp = await client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        hmac_data = resp.json()
        hmac_key = bytes.fromhex(hmac_data["keys"][str(hmac_data["current_version"])])

        # Create table
        await client.post(
            "/v1/db/tables",
            headers=api_headers,
            json={
                "name": "items",
                "columns": [
                    {
                        "name": "title",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {
                        "name": "code",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                ],
            },
        )

        # Insert
        code_ct = _fake_ciphertext("ABC123")
        code_idx = _blind_index("ABC123", hmac_key)

        resp = await client.post(
            "/v1/db/items/insert",
            headers=api_headers,
            json={
                "rows": [
                    {
                        "title": "Widget",
                        "code": code_ct,
                        "code_index": code_idx,
                    }
                ]
            },
        )
        assert resp.status_code == 201

        # Update: change the title via blind index filter on code
        resp = await client.post(
            "/v1/db/items/update",
            headers=api_headers,
            json={
                "values": {"title": "Widget V2"},
                "filters": [{"column": "code", "op": "eq", "value": code_idx}],
            },
        )
        assert resp.status_code == 200
        updated = resp.json()["data"]
        assert len(updated) == 1
        assert updated[0]["title"] == "Widget V2"

        # Verify update persisted
        resp = await client.post(
            "/v1/db/items/select",
            headers=api_headers,
            json={"filters": [{"column": "code", "op": "eq", "value": code_idx}]},
        )
        assert resp.json()["data"][0]["title"] == "Widget V2"

        # Delete via blind index
        resp = await client.post(
            "/v1/db/items/delete",
            headers=api_headers,
            json={"filters": [{"column": "code", "op": "eq", "value": code_idx}]},
        )
        assert resp.status_code == 200
        assert len(resp.json()["data"]) == 1

        # Verify deleted
        resp = await client.post(
            "/v1/db/items/select",
            headers=api_headers,
            json={},
        )
        assert resp.json()["data"] == []


# ---------------------------------------------------------------------------
# Test 6: Project isolation
# ---------------------------------------------------------------------------


class TestProjectIsolation:
    """Two projects -> data in project A not visible from project B's API key."""

    @pytest.mark.asyncio
    async def test_project_a_data_invisible_to_project_b(
        self, client: AsyncClient
    ) -> None:
        token = await signup_and_get_token(client, email="isolation@e2e.com")

        # Create two projects
        pid_a, keys_a, db_a = await create_project_and_get_keys(
            client, token, name="proj-a"
        )
        pid_b, keys_b, db_b = await create_project_and_get_keys(
            client, token, name="proj-b"
        )

        assert pid_a != pid_b
        assert db_a != db_b

        key_a = _get_anon_key(keys_a)
        key_b = _get_anon_key(keys_b)

        headers_a: dict[str, str] = {"apikey": key_a}
        headers_b: dict[str, str] = {"apikey": key_b}

        # Create same table name in both projects
        for headers in [headers_a, headers_b]:
            resp = await client.post(
                "/v1/db/tables",
                headers=headers,
                json={
                    "name": "notes",
                    "columns": [
                        {
                            "name": "body",
                            "data_type": "text",
                            "sensitivity": "plain",
                        },
                    ],
                },
            )
            assert resp.status_code == 201

        # Insert data only in project A
        resp = await client.post(
            "/v1/db/notes/insert",
            headers=headers_a,
            json={"rows": [{"body": "Secret note from A"}]},
        )
        assert resp.status_code == 201

        # Project A can see its data
        resp = await client.post(
            "/v1/db/notes/select",
            headers=headers_a,
            json={},
        )
        assert len(resp.json()["data"]) == 1
        assert resp.json()["data"][0]["body"] == "Secret note from A"

        # Project B sees empty table — complete isolation
        resp = await client.post(
            "/v1/db/notes/select",
            headers=headers_b,
            json={},
        )
        assert resp.json()["data"] == []

        # Verify at the Postgres level: different physical databases
        conn_a = await asyncpg.connect(
            f"postgresql://postgres:postgres@localhost:5432/{db_a}"
        )
        conn_b = await asyncpg.connect(
            f"postgresql://postgres:postgres@localhost:5432/{db_b}"
        )
        try:
            rows_a = await conn_a.fetch("SELECT * FROM notes")
            rows_b = await conn_b.fetch("SELECT * FROM notes")
            assert len(rows_a) == 1
            assert len(rows_b) == 0
        finally:
            await conn_a.close()
            await conn_b.close()
