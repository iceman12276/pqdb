"""Integration tests for owner column + RLS enforcement (US-028).

Boots the real FastAPI app with a real Postgres database.
Tests:
- Create table with owner column
- Owner column in schema introspection
- RLS: anon user sees only own rows
- RLS: service role sees all rows
- RLS: cross-user isolation
- RLS: anon without user context on owner table returns 403
- Add owner column to existing table
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.middleware.user_auth import UserContext, get_current_user
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.services.auth import generate_ed25519_keypair


def _make_rls_app(
    test_db_url: str,
    *,
    key_role: str = "anon",
    user_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> FastAPI:
    """Build a test app with configurable ProjectContext and UserContext.

    This allows testing RLS behavior with different roles and user contexts
    without needing real API key / JWT infrastructure.
    """
    _project_id = project_id or uuid.uuid4()
    _private_key, _public_key = generate_ed25519_keypair()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_project_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        async def _override_project_context() -> ProjectContext:
            return ProjectContext(
                project_id=_project_id,
                key_role=key_role,
                database_name="test",
            )

        async def _override_current_user() -> UserContext | None:
            if user_id is None:
                return None
            return UserContext(
                user_id=user_id,
                project_id=_project_id,
                role="authenticated",
                email_verified=True,
            )

        app.dependency_overrides[get_project_session] = _override_project_session
        app.dependency_overrides[get_project_context] = _override_project_context
        app.dependency_overrides[get_current_user] = _override_current_user
        app.state.jwt_public_key = _public_key
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(db_router)
    return app


class TestCreateTableWithOwner:
    """POST /v1/db/tables with owner column."""

    @pytest.fixture()
    def client(self, test_db_url: str) -> Iterator[TestClient]:
        app = _make_rls_app(test_db_url, key_role="service")
        with TestClient(app) as c:
            yield c

    def test_create_table_with_owner_column(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [
                    {"name": "title", "data_type": "text", "sensitivity": "plain"},
                    {
                        "name": "user_id",
                        "data_type": "uuid",
                        "sensitivity": "plain",
                        "owner": True,
                    },
                ],
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        cols = {c["name"]: c for c in data["columns"]}
        assert cols["user_id"]["is_owner"] is True
        assert cols["title"]["is_owner"] is False

    def test_create_table_multiple_owners_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "bad_table",
                "columns": [
                    {"name": "user_id", "data_type": "uuid", "owner": True},
                    {"name": "owner_id", "data_type": "uuid", "owner": True},
                ],
            },
        )
        assert resp.status_code == 400
        assert "is_owner" in resp.json()["detail"]

    def test_owner_column_must_be_uuid(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "bad_type",
                "columns": [
                    {"name": "user_id", "data_type": "text", "owner": True},
                ],
            },
        )
        assert resp.status_code == 400
        assert "uuid" in resp.json()["detail"].lower()

    def test_owner_column_must_be_plain(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": "bad_sens",
                "columns": [
                    {
                        "name": "user_id",
                        "data_type": "uuid",
                        "sensitivity": "private",
                        "owner": True,
                    },
                ],
            },
        )
        assert resp.status_code == 400
        assert "plain" in resp.json()["detail"].lower()


class TestIntrospectionWithOwner:
    """Schema introspection includes is_owner."""

    @pytest.fixture()
    def client(self, test_db_url: str) -> Iterator[TestClient]:
        app = _make_rls_app(test_db_url, key_role="service")
        with TestClient(app) as c:
            yield c

    def test_introspect_shows_is_owner(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [
                    {"name": "title", "data_type": "text"},
                    {"name": "user_id", "data_type": "uuid", "owner": True},
                ],
            },
        )
        resp = client.get("/v1/db/introspect/items")
        assert resp.status_code == 200
        cols = {c["name"]: c for c in resp.json()["columns"]}
        assert cols["user_id"]["is_owner"] is True
        assert cols["title"]["is_owner"] is False

    def test_get_table_shows_is_owner(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [
                    {"name": "title", "data_type": "text"},
                    {"name": "user_id", "data_type": "uuid", "owner": True},
                ],
            },
        )
        resp = client.get("/v1/db/tables/items")
        assert resp.status_code == 200
        cols = {c["name"]: c for c in resp.json()["columns"]}
        assert cols["user_id"]["is_owner"] is True


def _create_owner_table(client: TestClient) -> None:
    """Helper: create a table with an owner column."""
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": "items",
            "columns": [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
                {
                    "name": "user_id",
                    "data_type": "uuid",
                    "sensitivity": "plain",
                    "owner": True,
                },
            ],
        },
    )
    assert resp.status_code == 201


class TestRlsSelectIsolation:
    """Anon users only see their own rows; service sees all."""

    def test_anon_user_sees_only_own_rows(self, test_db_url: str) -> None:
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        project_id = uuid.uuid4()

        # Service role inserts rows for both users
        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={
                    "rows": [
                        {"title": "A item", "user_id": str(user_a)},
                        {"title": "B item", "user_id": str(user_b)},
                    ]
                },
            )

        # User A with anon role
        anon_a_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=user_a, project_id=project_id
        )
        with TestClient(anon_a_app) as anon_a:
            resp = anon_a.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["title"] == "A item"

        # User B with anon role
        anon_b_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=user_b, project_id=project_id
        )
        with TestClient(anon_b_app) as anon_b:
            resp = anon_b.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["title"] == "B item"

    def test_service_role_sees_all_rows(self, test_db_url: str) -> None:
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={
                    "rows": [
                        {"title": "A item", "user_id": str(user_a)},
                        {"title": "B item", "user_id": str(user_b)},
                    ]
                },
            )
            resp = svc.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 2


class TestRlsInsertEnforcement:
    """Anon insert must set owner column to authenticated user."""

    def test_anon_insert_matching_owner_succeeds(self, test_db_url: str) -> None:
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()

        # Create table with service role
        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)

        # Insert with anon role
        anon_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=user_id, project_id=project_id
        )
        with TestClient(anon_app) as anon:
            resp = anon.post(
                "/v1/db/items/insert",
                json={"rows": [{"title": "My item", "user_id": str(user_id)}]},
            )
            assert resp.status_code == 201

    def test_anon_insert_mismatched_owner_rejected(self, test_db_url: str) -> None:
        user_id = uuid.uuid4()
        other_id = uuid.uuid4()
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)

        anon_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=user_id, project_id=project_id
        )
        with TestClient(anon_app) as anon:
            resp = anon.post(
                "/v1/db/items/insert",
                json={"rows": [{"title": "Sneaky", "user_id": str(other_id)}]},
            )
            assert resp.status_code == 400
            assert "must match" in resp.json()["detail"]

    def test_anon_insert_missing_owner_rejected(self, test_db_url: str) -> None:
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)

        anon_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=user_id, project_id=project_id
        )
        with TestClient(anon_app) as anon:
            resp = anon.post(
                "/v1/db/items/insert",
                json={"rows": [{"title": "No owner"}]},
            )
            assert resp.status_code == 400
            assert "required" in resp.json()["detail"]


class TestRlsUpdateDeleteIsolation:
    """Anon can only update/delete own rows."""

    def test_anon_update_own_row(self, test_db_url: str) -> None:
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={
                    "rows": [
                        {"title": "A item", "user_id": str(user_a)},
                        {"title": "B item", "user_id": str(user_b)},
                    ]
                },
            )

        # User A tries to update all — RLS limits to own rows
        anon_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=user_a, project_id=project_id
        )
        with TestClient(anon_app) as anon:
            resp = anon.post(
                "/v1/db/items/update",
                json={
                    "values": {"title": "Updated"},
                    "filters": [{"column": "title", "op": "eq", "value": "A item"}],
                },
            )
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["title"] == "Updated"

        # Verify B's item is untouched
        with TestClient(svc_app) as svc:
            resp = svc.post(
                "/v1/db/items/select",
                json={"filters": [{"column": "title", "op": "eq", "value": "B item"}]},
            )
            assert len(resp.json()["data"]) == 1

    def test_anon_delete_own_row(self, test_db_url: str) -> None:
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={
                    "rows": [
                        {"title": "A item", "user_id": str(user_a)},
                        {"title": "B item", "user_id": str(user_b)},
                    ]
                },
            )

        # User A deletes — RLS limits to own rows
        anon_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=user_a, project_id=project_id
        )
        with TestClient(anon_app) as anon:
            resp = anon.post(
                "/v1/db/items/delete",
                json={"filters": [{"column": "title", "op": "eq", "value": "A item"}]},
            )
            assert resp.status_code == 200
            assert len(resp.json()["data"]) == 1

        # B's item still exists
        with TestClient(svc_app) as svc:
            resp = svc.post("/v1/db/items/select", json={})
            assert len(resp.json()["data"]) == 1
            assert resp.json()["data"][0]["title"] == "B item"


class TestRlsNoUserContext:
    """Anon without user context on owner table returns 403."""

    def test_anon_no_user_select_returns_403(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)

        # Anon without user context
        anon_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=None, project_id=project_id
        )
        with TestClient(anon_app) as anon:
            resp = anon.post("/v1/db/items/select", json={})
            assert resp.status_code == 403

    def test_anon_no_user_insert_returns_403(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)

        anon_app = _make_rls_app(
            test_db_url, key_role="anon", user_id=None, project_id=project_id
        )
        with TestClient(anon_app) as anon:
            resp = anon.post(
                "/v1/db/items/insert",
                json={"rows": [{"title": "test", "user_id": str(uuid.uuid4())}]},
            )
            assert resp.status_code == 403


class TestNoOwnerColumnNoRls:
    """Tables without owner column have no RLS applied."""

    @pytest.fixture()
    def client(self, test_db_url: str) -> Iterator[TestClient]:
        app = _make_rls_app(test_db_url, key_role="anon", user_id=uuid.uuid4())
        with TestClient(app) as c:
            yield c

    def test_anon_can_freely_crud_without_owner(self, client: TestClient) -> None:
        # Create table without owner column
        client.post(
            "/v1/db/tables",
            json={
                "name": "public_items",
                "columns": [
                    {"name": "title", "data_type": "text"},
                    {"name": "age", "data_type": "integer"},
                ],
            },
        )
        # Insert
        resp = client.post(
            "/v1/db/public_items/insert",
            json={"rows": [{"title": "Public", "age": 10}]},
        )
        assert resp.status_code == 201

        # Select all
        resp = client.post("/v1/db/public_items/select", json={})
        assert resp.status_code == 200
        assert len(resp.json()["data"]) == 1


class TestAddOwnerColumn:
    """POST /v1/db/tables/{name}/columns with owner flag."""

    @pytest.fixture()
    def client(self, test_db_url: str) -> Iterator[TestClient]:
        app = _make_rls_app(test_db_url, key_role="service")
        with TestClient(app) as c:
            yield c

    def test_add_owner_column_to_existing_table(self, client: TestClient) -> None:
        # Create table without owner
        client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [{"name": "title", "data_type": "text"}],
            },
        )
        # Add owner column
        resp = client.post(
            "/v1/db/tables/items/columns",
            json={"name": "user_id", "data_type": "uuid", "owner": True},
        )
        assert resp.status_code == 201
        assert resp.json()["is_owner"] is True

    def test_add_second_owner_column_rejected(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "items",
                "columns": [
                    {"name": "title", "data_type": "text"},
                    {"name": "user_id", "data_type": "uuid", "owner": True},
                ],
            },
        )
        resp = client.post(
            "/v1/db/tables/items/columns",
            json={"name": "owner_id", "data_type": "uuid", "owner": True},
        )
        assert resp.status_code == 400
        assert "already has an owner" in resp.json()["detail"]


class TestHealthCheck:
    """Health check still works."""

    @pytest.fixture()
    def client(self, test_db_url: str) -> Iterator[TestClient]:
        app = _make_rls_app(test_db_url, key_role="service")
        with TestClient(app) as c:
            yield c

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
