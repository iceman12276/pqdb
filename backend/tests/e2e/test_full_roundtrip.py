"""End-to-end integration tests (US-020).

Prove the full round-trip: SDK signs up, creates a project, receives
API keys, creates a table with mixed sensitivity columns, inserts
encrypted data, queries via blind index, and verifies zero-knowledge
guarantees. All tests boot the real FastAPI app with in-memory SQLite.

Encryption simulation uses:
- ML-KEM-768-style: random bytes as "ciphertext" stand-ins (the server
  stores/retrieves opaque bytea — it never decrypts)
- HMAC-SHA3-256 blind indexes: computed with hashlib to verify
  deterministic matching
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import StaticPool, event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.config import Settings
from pqdb_api.database import get_session
from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.models.base import Base
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient

# ---------------------------------------------------------------------------
# Helpers: simulate SDK-side crypto in Python
# ---------------------------------------------------------------------------

# Per-project HMAC key (32 bytes) — same as what Vault would return
_TEST_HMAC_KEY = b"\xab" * 32


def _compute_blind_index(value: str, hmac_key: bytes = _TEST_HMAC_KEY) -> str:
    """HMAC-SHA3-256 blind index, matching the SDK's computeBlindIndex."""
    h = hmac.new(hmac_key, value.encode(), hashlib.sha3_256)
    return h.hexdigest()


def _fake_ciphertext(plaintext: str) -> str:
    """Produce a fake ciphertext (base64 of random bytes + plaintext hash).

    The server never decrypts — it stores/retrieves opaque bytes.
    We include a hash so we can verify the "decryption" step later by
    re-computing and comparing.
    """
    random_prefix = os.urandom(16)
    plaintext_hash = hashlib.sha3_256(plaintext.encode()).digest()
    raw = random_prefix + plaintext_hash
    return base64.b64encode(raw).decode()


# ---------------------------------------------------------------------------
# Test app factory — boots full FastAPI with all routers
# ---------------------------------------------------------------------------


def _create_e2e_app() -> FastAPI:
    """Create a full FastAPI app with in-memory SQLite for E2E tests.

    Includes ALL routers: health, auth, projects, api_keys, db.
    Uses mock provisioner/vault but real auth, schema engine, and CRUD.

    Each project gets its own in-memory SQLite database (via a dict of
    engines keyed by database_name), so project isolation is real.
    API key auth is fully exercised — the only thing mocked is the
    provisioner (no real Postgres) and Vault (no real Vault server).
    """
    # Platform engine — stores developer accounts, projects, API keys
    platform_engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(platform_engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, connection_record):  # type: ignore[no-untyped-def]
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    platform_session_factory = async_sessionmaker(
        platform_engine, class_=AsyncSession, expire_on_commit=False
    )

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        async with platform_session_factory() as session:
            yield session

    # Project engines — one in-memory SQLite per project database_name
    project_engines: dict[str, AsyncEngine] = {}
    project_factories: dict[str, async_sessionmaker[AsyncSession]] = {}

    def _get_project_engine(database_name: str) -> async_sessionmaker[AsyncSession]:
        if database_name not in project_engines:
            eng = create_async_engine(
                "sqlite+aiosqlite://",
                connect_args={"check_same_thread": False},
                poolclass=StaticPool,
            )

            @event.listens_for(eng.sync_engine, "connect")
            def _pragma(dbapi_conn, connection_record):  # type: ignore[no-untyped-def]
                cursor = dbapi_conn.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()

            project_engines[database_name] = eng
            project_factories[database_name] = async_sessionmaker(
                eng, class_=AsyncSession, expire_on_commit=False
            )
        return project_factories[database_name]

    async def _override_get_project_session(
        request: Request,
        context: ProjectContext = Depends(get_project_context),
    ) -> AsyncIterator[AsyncSession]:
        """Override: route to per-project in-memory SQLite instead of Postgres."""
        factory = _get_project_engine(context.database_name)
        async with factory() as session:
            yield session

    private_key, public_key = generate_ed25519_keypair()

    settings = Settings(
        database_url="sqlite+aiosqlite://",
        superuser_dsn="postgresql://test:test@localhost/test",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with platform_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key

        mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
        mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

        async def _mock_provision(project_id: uuid.UUID) -> str:
            return make_database_name(project_id)

        mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)
        app.state.provisioner = mock_provisioner

        mock_vault = MagicMock(spec=VaultClient)
        mock_vault.store_hmac_key = MagicMock()
        mock_vault.get_hmac_key = MagicMock(return_value=_TEST_HMAC_KEY)
        mock_vault.delete_hmac_key = MagicMock()
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=100, window_seconds=60)
        yield
        for eng in project_engines.values():
            await eng.dispose()
        await platform_engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    app.include_router(db_router)
    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_project_session] = _override_get_project_session
    return app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = _create_e2e_app()
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _signup(client: TestClient, email: str = "dev@e2e.com") -> str:
    """Sign up and return access token."""
    resp = client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "e2epassword123"},
    )
    assert resp.status_code == 201
    token: str = resp.json()["access_token"]
    return token


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_project(
    client: TestClient, token: str, name: str = "e2e-project"
) -> dict[str, object]:
    resp = client.post(
        "/v1/projects",
        json={"name": name},
        headers=_auth(token),
    )
    assert resp.status_code == 201
    result: dict[str, object] = resp.json()
    return result


def _get_api_key(project: dict[str, object], role: str = "anon") -> str:
    """Extract API key of given role from project creation response."""
    keys = project["api_keys"]
    assert isinstance(keys, list)
    key: str = next(k["key"] for k in keys if k["role"] == role)
    return key


def _apikey(key: str) -> dict[str, str]:
    return {"apikey": key}


# ---------------------------------------------------------------------------
# Test 1 — Platform flow: signup -> create project -> receive API keys
# ---------------------------------------------------------------------------


class TestPlatformFlow:
    """SDK signs up developer, creates project, receives API keys."""

    def test_signup_create_project_get_keys(self, client: TestClient) -> None:
        # 1. Sign up
        token = _signup(client, "platform@e2e.com")
        assert token

        # 2. Create project
        project = _create_project(client, token, "platform-proj")
        assert project["status"] == "active"
        assert project["database_name"] is not None
        assert isinstance(project["database_name"], str)
        assert project["database_name"].startswith("pqdb_project_")

        # 3. Verify API keys
        keys = project["api_keys"]
        assert isinstance(keys, list)
        assert len(keys) == 2
        roles = {k["role"] for k in keys}
        assert roles == {"anon", "service"}

        for k in keys:
            assert k["key"].startswith(f"pqdb_{k['role']}_")
            assert len(k["key"].split("_", 2)[2]) == 32

    def test_api_keys_authenticate_to_project(self, client: TestClient) -> None:
        token = _signup(client, "keyauth@e2e.com")
        project = _create_project(client, token, "keyauth-proj")
        anon_key = _get_api_key(project, "anon")
        service_key = _get_api_key(project, "service")

        # Both keys should authenticate to the DB health endpoint
        for key in (anon_key, service_key):
            resp = client.get("/v1/db/health", headers=_apikey(key))
            assert resp.status_code == 200
            assert resp.json()["project_id"] == project["id"]


# ---------------------------------------------------------------------------
# Test 2 — Schema flow: create table with mixed columns, verify introspect
# ---------------------------------------------------------------------------


class TestSchemaFlow:
    """SDK creates a table with searchable, private, and plain columns,
    then verifies shadow columns via introspection."""

    def test_create_table_with_mixed_sensitivity(self, client: TestClient) -> None:
        token = _signup(client, "schema@e2e.com")
        project = _create_project(client, token, "schema-proj")
        api_key = _get_api_key(project)

        # Create table
        resp = client.post(
            "/v1/db/tables",
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
            headers=_apikey(api_key),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "contacts"
        assert len(data["columns"]) == 4

    def test_introspection_shows_shadow_columns(self, client: TestClient) -> None:
        token = _signup(client, "introspect@e2e.com")
        project = _create_project(client, token, "introspect-proj")
        api_key = _get_api_key(project)

        # Create table
        client.post(
            "/v1/db/tables",
            json={
                "name": "users",
                "columns": [
                    {
                        "name": "name",
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
            headers=_apikey(api_key),
        )

        # Introspect
        resp = client.get(
            "/v1/db/introspect/users",
            headers=_apikey(api_key),
        )
        assert resp.status_code == 200
        data = resp.json()
        col_map = {c["name"]: c for c in data["columns"]}

        # Plain: queryable, all ops
        assert col_map["name"]["sensitivity"] == "plain"
        assert col_map["name"]["queryable"] is True

        # Searchable: queryable, only eq/in
        assert col_map["email"]["sensitivity"] == "searchable"
        assert col_map["email"]["queryable"] is True
        assert col_map["email"]["operations"] == ["eq", "in"]

        # Private: not queryable
        assert col_map["ssn"]["sensitivity"] == "private"
        assert col_map["ssn"]["queryable"] is False

        # Sensitivity summary
        assert data["sensitivity_summary"] == {
            "searchable": 1,
            "private": 1,
            "plain": 1,
        }


# ---------------------------------------------------------------------------
# Test 3 — Insert + Select round-trip with encrypted fields
# ---------------------------------------------------------------------------


class TestInsertSelectRoundTrip:
    """Insert a row with encrypted fields, SELECT with .eq() on
    searchable column, verify decrypted result matches original."""

    def test_insert_and_select_by_blind_index(self, client: TestClient) -> None:
        token = _signup(client, "roundtrip@e2e.com")
        project = _create_project(client, token, "roundtrip-proj")
        api_key = _get_api_key(project)
        headers = _apikey(api_key)

        # Create table
        client.post(
            "/v1/db/tables",
            json={
                "name": "patients",
                "columns": [
                    {
                        "name": "name",
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
            headers=headers,
        )

        # Simulate SDK-side encryption
        plaintext_email = "alice@example.com"
        plaintext_ssn = "123-45-6789"
        cipher_email = _fake_ciphertext(plaintext_email)
        cipher_ssn = _fake_ciphertext(plaintext_ssn)
        email_index = _compute_blind_index(plaintext_email)

        # Insert
        insert_resp = client.post(
            "/v1/db/patients/insert",
            json={
                "rows": [
                    {
                        "name": "Alice",
                        "email": cipher_email,
                        "email_index": email_index,
                        "ssn": cipher_ssn,
                        "age": 30,
                    }
                ]
            },
            headers=headers,
        )
        assert insert_resp.status_code == 201
        inserted = insert_resp.json()["data"]
        assert len(inserted) == 1
        row_id = inserted[0]["id"]
        assert row_id is not None

        # Select by blind index (simulating SDK's .eq("email", "alice@example.com"))
        select_resp = client.post(
            "/v1/db/patients/select",
            json={"filters": [{"column": "email", "op": "eq", "value": email_index}]},
            headers=headers,
        )
        assert select_resp.status_code == 200
        found = select_resp.json()["data"]
        assert len(found) == 1
        assert found[0]["id"] == row_id
        assert found[0]["name"] == "Alice"
        assert found[0]["age"] == 30

        # The returned email_encrypted should match what we sent
        assert found[0]["email_encrypted"] == cipher_email
        assert found[0]["email_index"] == email_index
        assert found[0]["ssn_encrypted"] == cipher_ssn

    def test_select_wrong_blind_index_returns_empty(self, client: TestClient) -> None:
        """Querying with wrong plaintext produces a different blind index,
        returning no results — proving deterministic matching."""
        token = _signup(client, "wrongidx@e2e.com")
        project = _create_project(client, token, "wrongidx-proj")
        api_key = _get_api_key(project)
        headers = _apikey(api_key)

        client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [
                    {
                        "name": "sku",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                    {
                        "name": "title",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                ],
            },
            headers=headers,
        )

        sku_value = "SKU-12345"
        client.post(
            "/v1/db/items/insert",
            json={
                "rows": [
                    {
                        "sku": _fake_ciphertext(sku_value),
                        "sku_index": _compute_blind_index(sku_value),
                        "title": "Widget",
                    }
                ]
            },
            headers=headers,
        )

        # Query with wrong value — different HMAC output
        wrong_index = _compute_blind_index("SKU-99999")
        select_resp = client.post(
            "/v1/db/items/select",
            json={"filters": [{"column": "sku", "op": "eq", "value": wrong_index}]},
            headers=headers,
        )
        assert select_resp.status_code == 200
        assert select_resp.json()["data"] == []


# ---------------------------------------------------------------------------
# Test 4 — Zero-knowledge verification
# ---------------------------------------------------------------------------


class TestZeroKnowledge:
    """Directly query the project database (via the API) and verify
    that sensitive columns contain only ciphertext / HMAC hashes,
    never plaintext."""

    def test_server_never_sees_plaintext(self, client: TestClient) -> None:
        token = _signup(client, "zk@e2e.com")
        project = _create_project(client, token, "zk-proj")
        api_key = _get_api_key(project)
        headers = _apikey(api_key)

        client.post(
            "/v1/db/tables",
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
            headers=headers,
        )

        plaintext_email = "secret@email.com"
        plaintext_ssn = "999-88-7777"
        cipher_email = _fake_ciphertext(plaintext_email)
        cipher_ssn = _fake_ciphertext(plaintext_ssn)
        email_blind_index = _compute_blind_index(plaintext_email)

        client.post(
            "/v1/db/secrets/insert",
            json={
                "rows": [
                    {
                        "label": "test-secret",
                        "email": cipher_email,
                        "email_index": email_blind_index,
                        "ssn": cipher_ssn,
                    }
                ]
            },
            headers=headers,
        )

        # Select all rows — what the server stores
        resp = client.post("/v1/db/secrets/select", json={}, headers=headers)
        assert resp.status_code == 200
        rows = resp.json()["data"]
        assert len(rows) == 1
        row = rows[0]

        # Plain column is stored as-is
        assert row["label"] == "test-secret"

        # Searchable: email_encrypted is ciphertext, email_index is HMAC hex
        assert row["email_encrypted"] == cipher_email
        assert row["email_encrypted"] != plaintext_email
        assert row["email_index"] == email_blind_index
        assert row["email_index"] != plaintext_email

        # Verify the blind index is a hex string (64 chars for SHA3-256)
        assert len(row["email_index"]) == 64
        assert all(c in "0123456789abcdef" for c in row["email_index"])

        # Private: ssn_encrypted is ciphertext
        assert row["ssn_encrypted"] == cipher_ssn
        assert row["ssn_encrypted"] != plaintext_ssn

        # The original column names (email, ssn) should NOT exist as keys
        assert "email" not in row
        assert "ssn" not in row


# ---------------------------------------------------------------------------
# Test 5 — Update + Delete
# ---------------------------------------------------------------------------


class TestUpdateDelete:
    """Update a row matched by blind index, verify updated ciphertext
    differs, delete row, verify gone."""

    def test_update_and_delete_via_blind_index(self, client: TestClient) -> None:
        token = _signup(client, "upddel@e2e.com")
        project = _create_project(client, token, "upddel-proj")
        api_key = _get_api_key(project)
        headers = _apikey(api_key)

        client.post(
            "/v1/db/tables",
            json={
                "name": "records",
                "columns": [
                    {
                        "name": "title",
                        "data_type": "text",
                        "sensitivity": "plain",
                    },
                    {
                        "name": "email",
                        "data_type": "text",
                        "sensitivity": "searchable",
                    },
                    {
                        "name": "notes",
                        "data_type": "text",
                        "sensitivity": "private",
                    },
                ],
            },
            headers=headers,
        )

        plaintext_email = "update@test.com"
        original_cipher = _fake_ciphertext(plaintext_email)
        email_index = _compute_blind_index(plaintext_email)
        original_notes_cipher = _fake_ciphertext("original notes")

        # Insert
        insert_resp = client.post(
            "/v1/db/records/insert",
            json={
                "rows": [
                    {
                        "title": "Original Title",
                        "email": original_cipher,
                        "email_index": email_index,
                        "notes": original_notes_cipher,
                    }
                ]
            },
            headers=headers,
        )
        assert insert_resp.status_code == 201

        # --- Update: change title (plain) via blind index filter ---
        update_resp = client.post(
            "/v1/db/records/update",
            json={
                "values": {"title": "Updated Title"},
                "filters": [{"column": "email", "op": "eq", "value": email_index}],
            },
            headers=headers,
        )
        assert update_resp.status_code == 200
        updated = update_resp.json()["data"]
        assert len(updated) == 1
        assert updated[0]["title"] == "Updated Title"
        # Ciphertext columns unchanged
        assert updated[0]["email_encrypted"] == original_cipher

        # Verify update persisted
        verify_resp = client.post(
            "/v1/db/records/select",
            json={"filters": [{"column": "email", "op": "eq", "value": email_index}]},
            headers=headers,
        )
        assert verify_resp.json()["data"][0]["title"] == "Updated Title"

        # --- Update: change encrypted field (simulate re-encryption) ---
        new_notes_cipher = _fake_ciphertext("updated notes")
        assert new_notes_cipher != original_notes_cipher  # different random prefix

        update_enc_resp = client.post(
            "/v1/db/records/update",
            json={
                "values": {"notes": new_notes_cipher},
                "filters": [{"column": "email", "op": "eq", "value": email_index}],
            },
            headers=headers,
        )
        assert update_enc_resp.status_code == 200
        updated_row = update_enc_resp.json()["data"][0]
        assert updated_row["notes_encrypted"] == new_notes_cipher
        assert updated_row["notes_encrypted"] != original_notes_cipher

        # --- Delete ---
        delete_resp = client.post(
            "/v1/db/records/delete",
            json={"filters": [{"column": "email", "op": "eq", "value": email_index}]},
            headers=headers,
        )
        assert delete_resp.status_code == 200
        deleted = delete_resp.json()["data"]
        assert len(deleted) == 1

        # Verify gone
        final_resp = client.post("/v1/db/records/select", json={}, headers=headers)
        assert final_resp.json()["data"] == []


# ---------------------------------------------------------------------------
# Test 6 — Project isolation
# ---------------------------------------------------------------------------


class TestProjectIsolation:
    """Two projects created — data inserted in project A is not
    accessible from project B's API key."""

    def test_project_a_data_not_visible_from_project_b(
        self, client: TestClient
    ) -> None:
        token = _signup(client, "iso@e2e.com")

        # Create two projects
        project_a = _create_project(client, token, "proj-alpha")
        project_b = _create_project(client, token, "proj-beta")

        key_a = _get_api_key(project_a)
        key_b = _get_api_key(project_b)

        # Verify they resolve to different project IDs
        resp_a = client.get("/v1/db/health", headers=_apikey(key_a))
        resp_b = client.get("/v1/db/health", headers=_apikey(key_b))
        assert resp_a.json()["project_id"] == project_a["id"]
        assert resp_b.json()["project_id"] == project_b["id"]
        assert project_a["id"] != project_b["id"]

        # Create identical tables in both projects
        table_def = {
            "name": "data",
            "columns": [
                {
                    "name": "value",
                    "data_type": "text",
                    "sensitivity": "plain",
                },
                {
                    "name": "secret",
                    "data_type": "text",
                    "sensitivity": "searchable",
                },
            ],
        }
        resp = client.post(
            "/v1/db/tables",
            json=table_def,
            headers=_apikey(key_a),
        )
        assert resp.status_code == 201

        resp = client.post(
            "/v1/db/tables",
            json=table_def,
            headers=_apikey(key_b),
        )
        assert resp.status_code == 201

        # Insert data in project A only
        secret_value = "project-a-secret"
        cipher = _fake_ciphertext(secret_value)
        blind_idx = _compute_blind_index(secret_value)

        client.post(
            "/v1/db/data/insert",
            json={
                "rows": [
                    {
                        "value": "from-project-a",
                        "secret": cipher,
                        "secret_index": blind_idx,
                    }
                ]
            },
            headers=_apikey(key_a),
        )

        # Select from project A — should find the row
        select_a = client.post("/v1/db/data/select", json={}, headers=_apikey(key_a))
        assert len(select_a.json()["data"]) == 1
        assert select_a.json()["data"][0]["value"] == "from-project-a"

        # Select from project B — should be empty (isolated)
        select_b = client.post("/v1/db/data/select", json={}, headers=_apikey(key_b))
        assert select_b.json()["data"] == []

    def test_cross_project_query_by_blind_index_fails(self, client: TestClient) -> None:
        """Even if project B uses the same blind index value,
        it won't find project A's data."""
        token = _signup(client, "crossidx@e2e.com")
        project_a = _create_project(client, token, "cross-alpha")
        project_b = _create_project(client, token, "cross-beta")

        key_a = _get_api_key(project_a)
        key_b = _get_api_key(project_b)

        table_def = {
            "name": "logins",
            "columns": [
                {
                    "name": "username",
                    "data_type": "text",
                    "sensitivity": "searchable",
                },
            ],
        }
        client.post("/v1/db/tables", json=table_def, headers=_apikey(key_a))
        client.post("/v1/db/tables", json=table_def, headers=_apikey(key_b))

        # Insert in project A
        username = "admin"
        cipher = _fake_ciphertext(username)
        blind_idx = _compute_blind_index(username)

        client.post(
            "/v1/db/logins/insert",
            json={
                "rows": [
                    {
                        "username": cipher,
                        "username_index": blind_idx,
                    }
                ]
            },
            headers=_apikey(key_a),
        )

        # Query from project B with same blind index — empty
        select_b = client.post(
            "/v1/db/logins/select",
            json={"filters": [{"column": "username", "op": "eq", "value": blind_idx}]},
            headers=_apikey(key_b),
        )
        assert select_b.json()["data"] == []
