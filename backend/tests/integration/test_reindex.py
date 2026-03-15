"""Integration tests for the re-indexing service (US-023).

Tests the full flow: create project, create table with searchable columns,
insert data, rotate key, reindex, verify indexes updated, delete old version.

Uses real Postgres with a mock VaultClient.
"""

from __future__ import annotations

import hashlib
import hmac
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.middleware.api_key import get_project_session
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient
from tests.integration.conftest import (
    auth_headers,
    create_project,
    signup_and_get_token,
)


def _make_reindex_app(test_db_url: str) -> FastAPI:
    """Build a test app where platform and project sessions use the same DB.

    This is needed because the reindex endpoint uses _get_project_session
    internally, which builds a project-scoped connection. In tests, we
    override it so both platform and project data live in the same DB.
    """
    private_key, public_key = generate_ed25519_keypair()
    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return make_database_name(project_id)

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    # Versioned vault mock
    import secrets as _secrets

    stored_keys: dict[str, bytes] = {}
    versioned_store: dict[str, dict[str, bytes]] = {}
    version_counters: dict[str, int] = {}

    def _mock_store(project_id: uuid.UUID, key: bytes) -> None:
        pid = str(project_id)
        stored_keys[pid] = key
        versioned_store[pid] = {"1": key}
        version_counters[pid] = 1

    def _mock_get_keys(project_id: uuid.UUID) -> Any:
        from pqdb_api.services.vault import VaultError, VersionedHmacKeys

        pid = str(project_id)
        if pid not in versioned_store:
            raise VaultError("Key not found")
        current_ver = version_counters.get(pid, 1)
        keys_hex = {v: k.hex() for v, k in versioned_store[pid].items()}
        return VersionedHmacKeys(current_version=current_ver, keys=keys_hex)

    def _mock_rotate(project_id: uuid.UUID) -> Any:
        from pqdb_api.services.vault import VaultError, VersionedHmacKeys

        pid = str(project_id)
        if pid not in versioned_store:
            raise VaultError("Key not found")
        current_ver = version_counters.get(pid, 1)
        new_ver = current_ver + 1
        new_key = _secrets.token_bytes(32)
        versioned_store[pid][str(new_ver)] = new_key
        version_counters[pid] = new_ver
        stored_keys[pid] = new_key
        keys_hex = {v: k.hex() for v, k in versioned_store[pid].items()}
        return VersionedHmacKeys(current_version=new_ver, keys=keys_hex)

    def _mock_delete_version(project_id: uuid.UUID, version: int) -> Any:
        from pqdb_api.services.vault import VaultError, VersionedHmacKeys

        pid = str(project_id)
        if pid not in versioned_store:
            raise VaultError("Key not found")
        current_ver = version_counters.get(pid, 1)
        if version == current_ver:
            raise VaultError(f"Cannot delete current key version {version}")
        vs = str(version)
        if vs not in versioned_store[pid]:
            raise VaultError(f"Key version {version} not found")
        del versioned_store[pid][vs]
        keys_hex = {v: k.hex() for v, k in versioned_store[pid].items()}
        return VersionedHmacKeys(current_version=current_ver, keys=keys_hex)

    mock_vault = MagicMock(spec=VaultClient)
    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store)
    mock_vault.get_hmac_keys = MagicMock(side_effect=_mock_get_keys)
    mock_vault.rotate_hmac_key = MagicMock(side_effect=_mock_rotate)
    mock_vault.delete_hmac_key_version = MagicMock(side_effect=_mock_delete_version)
    mock_vault.delete_hmac_key = MagicMock()

    from pqdb_api.config import Settings

    settings = Settings(
        database_url=test_db_url,
        superuser_dsn="postgresql://test:test@localhost/test",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_session] = _override_get_session
        app.dependency_overrides[get_project_session] = _override_get_project_session
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=100, window_seconds=60)
        app.state.settings = settings
        # Allow reindex routes to get project-scoped sessions from test DB
        app.state._test_project_session_factory = session_factory
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(db_router)
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_reindex_app(test_db_url)
    with TestClient(app) as c:
        yield c


def _create_project_with_table(
    client: TestClient,
    token: str,
    table_name: str = "users",
) -> tuple[str, str]:
    """Create a project and a table with a searchable column.

    Returns (project_id, service_role_key).
    """
    project = create_project(client, token)
    project_id = project["id"]

    # Get a service_role API key
    service_key = None
    for k in project["api_keys"]:
        if k["role"] == "service":
            service_key = k["key"]
    assert service_key is not None

    # Create table with searchable column
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": table_name,
            "columns": [
                {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                {"name": "note", "data_type": "text", "sensitivity": "private"},
                {"name": "age", "data_type": "integer", "sensitivity": "plain"},
            ],
        },
        headers={"apikey": service_key},
    )
    assert resp.status_code == 201, resp.text

    return project_id, service_key


class TestReindexRouteExists:
    """Verify re-index routes are registered."""

    def test_reindex_post_route_exists(self, client: TestClient) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/reindex")
        assert resp.status_code != 404

    def test_reindex_status_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/reindex/status")
        assert resp.status_code != 404

    def test_delete_version_route_exists(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}/hmac-key/versions/1")
        assert resp.status_code != 404


class TestReindexAuth:
    """Re-index requires developer JWT."""

    def test_reindex_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.post(f"/v1/projects/{uuid.uuid4()}/reindex")
        assert resp.status_code in (401, 403)

    def test_reindex_status_without_auth_returns_401_or_403(
        self,
        client: TestClient,
    ) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/reindex/status")
        assert resp.status_code in (401, 403)


class TestReindexFlow:
    """Full re-indexing flow integration tests."""

    def test_reindex_empty_project_completes(self, client: TestClient) -> None:
        """Re-indexing a project with no tables should complete instantly."""
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.post(
            f"/v1/projects/{project_id}/reindex",
            headers=auth_headers(token),
        )
        assert resp.status_code == 202
        data = resp.json()
        assert "job_id" in data

        # Check status
        status_resp = client.get(
            f"/v1/projects/{project_id}/reindex/status",
            headers=auth_headers(token),
        )
        assert status_resp.status_code == 200
        status = status_resp.json()
        assert status["status"] == "complete"
        assert status["tables_total"] == 0

    def test_reindex_updates_blind_indexes(self, client: TestClient) -> None:
        """Insert data, rotate key, reindex — indexes should be updated."""
        token = signup_and_get_token(client)
        project_id, service_key = _create_project_with_table(client, token)

        # Get the current HMAC key (version 1)
        hmac_resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        v1_key_hex = hmac_resp.json()["keys"]["1"]
        v1_key = bytes.fromhex(v1_key_hex)

        # Insert a row with version-prefixed blind index
        email_ciphertext = b"encrypted-email-bytes"
        note_ciphertext = b"encrypted-note-bytes"
        v1_index = (
            "v1:" + hmac.new(v1_key, email_ciphertext, hashlib.sha3_256).hexdigest()
        )

        insert_resp = client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {
                        "email": email_ciphertext.decode("utf-8"),
                        "email_index": v1_index,
                        "note": note_ciphertext.decode("utf-8"),
                        "age": 30,
                    }
                ]
            },
            headers={"apikey": service_key},
        )
        assert insert_resp.status_code == 201, insert_resp.text

        # Verify index is v1
        select_resp = client.post(
            "/v1/db/users/select",
            json={"columns": ["*"]},
            headers={"apikey": service_key},
        )
        assert select_resp.status_code == 200
        rows = select_resp.json()["data"]
        assert len(rows) == 1
        assert rows[0]["email_index"].startswith("v1:")

        # Rotate HMAC key to v2
        rotate_resp = client.post(
            f"/v1/projects/{project_id}/hmac-key/rotate",
            headers=auth_headers(token),
        )
        assert rotate_resp.status_code == 200
        assert rotate_resp.json()["current_version"] == 2

        # Re-index
        reindex_resp = client.post(
            f"/v1/projects/{project_id}/reindex",
            headers=auth_headers(token),
        )
        assert reindex_resp.status_code == 202
        assert "job_id" in reindex_resp.json()

        # Verify indexes are now v2
        select_resp2 = client.post(
            "/v1/db/users/select",
            json={"columns": ["*"]},
            headers={"apikey": service_key},
        )
        assert select_resp2.status_code == 200
        rows2 = select_resp2.json()["data"]
        assert len(rows2) == 1
        assert rows2[0]["email_index"].startswith("v2:")

        # Get v2 key and verify the index value
        hmac_resp2 = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        v2_key_hex = hmac_resp2.json()["keys"]["2"]
        v2_key = bytes.fromhex(v2_key_hex)
        expected_v2_index = (
            "v2:" + hmac.new(v2_key, email_ciphertext, hashlib.sha3_256).hexdigest()
        )
        assert rows2[0]["email_index"] == expected_v2_index

    def test_reindex_is_idempotent(self, client: TestClient) -> None:
        """Running reindex twice should produce the same result."""
        token = signup_and_get_token(client)
        project_id, service_key = _create_project_with_table(client, token)

        # Insert data with v1 index
        hmac_resp = client.get(
            f"/v1/projects/{project_id}/hmac-key",
            headers=auth_headers(token),
        )
        v1_key = bytes.fromhex(hmac_resp.json()["keys"]["1"])
        ciphertext = b"test-cipher"
        v1_index = "v1:" + hmac.new(v1_key, ciphertext, hashlib.sha3_256).hexdigest()

        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {
                        "email": ciphertext.decode("utf-8"),
                        "email_index": v1_index,
                        "note": "enc-note",
                        "age": 25,
                    }
                ]
            },
            headers={"apikey": service_key},
        )

        # Re-index (still on v1 — should be no-op since indexes already v1)
        resp1 = client.post(
            f"/v1/projects/{project_id}/reindex",
            headers=auth_headers(token),
        )
        assert resp1.status_code == 202

        # Select and get index
        select1 = client.post(
            "/v1/db/users/select",
            json={"columns": ["*"]},
            headers={"apikey": service_key},
        )
        idx1 = select1.json()["data"][0]["email_index"]

        # Re-index again — should be idempotent
        resp2 = client.post(
            f"/v1/projects/{project_id}/reindex",
            headers=auth_headers(token),
        )
        assert resp2.status_code == 202

        select2 = client.post(
            "/v1/db/users/select",
            json={"columns": ["*"]},
            headers={"apikey": service_key},
        )
        idx2 = select2.json()["data"][0]["email_index"]

        assert idx1 == idx2

    def test_reindex_status_shows_progress(self, client: TestClient) -> None:
        """Status endpoint should show job details."""
        token = signup_and_get_token(client)
        project_id, service_key = _create_project_with_table(client, token)

        # Start reindex
        client.post(
            f"/v1/projects/{project_id}/reindex",
            headers=auth_headers(token),
        )

        # Check status
        status_resp = client.get(
            f"/v1/projects/{project_id}/reindex/status",
            headers=auth_headers(token),
        )
        assert status_resp.status_code == 200
        status = status_resp.json()
        assert status["status"] in ("running", "complete")
        assert "tables_done" in status
        assert "tables_total" in status
        assert "job_id" in status
        assert "started_at" in status

    def test_no_reindex_status_returns_404(self, client: TestClient) -> None:
        """Status before any reindex should return 404."""
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.get(
            f"/v1/projects/{project_id}/reindex/status",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestDeleteHmacKeyVersion:
    """Tests for DELETE /v1/projects/{id}/hmac-key/versions/{version}."""

    def test_delete_old_version_after_reindex(self, client: TestClient) -> None:
        """After rotate + reindex, old version should be deletable."""
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        # Rotate to v2
        client.post(
            f"/v1/projects/{project_id}/hmac-key/rotate",
            headers=auth_headers(token),
        )

        # Delete old version 1
        resp = client.delete(
            f"/v1/projects/{project_id}/hmac-key/versions/1",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["current_version"] == 2
        assert "1" not in data["remaining_versions"]
        assert "2" in data["remaining_versions"]

    def test_cannot_delete_current_version(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}/hmac-key/versions/1",
            headers=auth_headers(token),
        )
        assert resp.status_code == 400
        assert "Cannot delete current" in resp.json()["detail"]

    def test_delete_nonexistent_version(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        project = create_project(client, token)
        project_id = project["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}/hmac-key/versions/99",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404

    def test_delete_version_wrong_project_returns_404(self, client: TestClient) -> None:
        token = signup_and_get_token(client)
        resp = client.delete(
            f"/v1/projects/{uuid.uuid4()}/hmac-key/versions/1",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404
