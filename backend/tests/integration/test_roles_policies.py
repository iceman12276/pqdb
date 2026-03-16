"""Integration tests for custom roles + RLS policies (US-040).

Boots the real FastAPI app with a real Postgres database.
Tests:
- Role CRUD via API endpoints
- Policy CRUD via API endpoints
- User role assignment via service API key
- Policy-based RLS enforcement (role-based access)
- Fallback to basic owner-column RLS when no policies exist
- Service role bypass
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

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
from pqdb_api.routes.policies import router as policies_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair


def _make_rls_app(
    test_db_url: str,
    *,
    key_role: str = "anon",
    user_id: uuid.UUID | None = None,
    user_role: str = "authenticated",
    project_id: uuid.UUID | None = None,
) -> FastAPI:
    """Build a test app with configurable ProjectContext and UserContext.

    Supports custom user_role for policy-based RLS testing.
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
                role=user_role,
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
    app.include_router(user_auth_router)
    app.include_router(db_router)
    app.include_router(policies_router)
    return app


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


def _create_public_table(client: TestClient) -> None:
    """Helper: create a table without an owner column."""
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": "posts",
            "columns": [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
                {"name": "content", "data_type": "text", "sensitivity": "plain"},
            ],
        },
    )
    assert resp.status_code == 201


class TestPolicyCrud:
    """Create, list, and delete policies via API endpoints."""

    def test_create_policy(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(app) as client:
            _create_owner_table(client)
            resp = client.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "owner",
                },
                headers={"Authorization": "Bearer dummy"},
            )
            assert resp.status_code == 201
            data = resp.json()
            assert data["table_name"] == "items"
            assert data["operation"] == "select"
            assert data["role"] == "authenticated"
            assert data["condition"] == "owner"

    def test_create_duplicate_policy_returns_409(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(app) as client:
            _create_owner_table(client)
            client.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "owner",
                },
                headers={"Authorization": "Bearer dummy"},
            )
            resp = client.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select_dup",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "all",
                },
                headers={"Authorization": "Bearer dummy"},
            )
            assert resp.status_code == 409

    def test_list_policies(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(app) as client:
            _create_owner_table(client)
            client.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "owner",
                },
                headers={"Authorization": "Bearer dummy"},
            )
            resp = client.get("/v1/db/tables/items/policies")
            assert resp.status_code == 200
            policies = resp.json()
            assert len(policies) == 1
            assert policies[0]["name"] == "auth_select"

    def test_delete_policy(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(app) as client:
            _create_owner_table(client)
            create_resp = client.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "owner",
                },
                headers={"Authorization": "Bearer dummy"},
            )
            policy_id = create_resp.json()["id"]
            resp = client.delete(
                f"/v1/db/tables/items/policies/{policy_id}",
                headers={"Authorization": "Bearer dummy"},
            )
            assert resp.status_code == 204

            # Verify deleted
            list_resp = client.get("/v1/db/tables/items/policies")
            assert len(list_resp.json()) == 0

    def test_create_policy_requires_developer_jwt(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(app) as client:
            _create_owner_table(client)
            resp = client.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "owner",
                },
                # No Authorization header
            )
            assert resp.status_code == 401

    def test_create_policy_for_nonexistent_role_returns_400(
        self, test_db_url: str
    ) -> None:
        project_id = uuid.uuid4()
        app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(app) as client:
            _create_owner_table(client)
            resp = client.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "ghost_select",
                    "operation": "select",
                    "role": "ghost_role",
                    "condition": "all",
                },
                headers={"Authorization": "Bearer dummy"},
            )
            assert resp.status_code == 400
            assert "does not exist" in resp.json()["detail"]


class TestUserRoleAssignment:
    """PUT /v1/auth/users/{user_id}/role endpoint."""

    def test_service_key_can_assign_role(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = _make_rls_app(
            test_db_url,
            key_role="service",
            user_id=user_id,
            project_id=project_id,
        )
        with TestClient(app) as client:
            # First sign up a user directly in the DB
            import asyncio

            from sqlalchemy import text as sa_text

            from pqdb_api.services.auth import hash_password
            from pqdb_api.services.auth_engine import ensure_auth_tables

            async def _setup() -> None:
                engine = create_async_engine(test_db_url)
                factory = async_sessionmaker(
                    engine, class_=AsyncSession, expire_on_commit=False
                )
                async with factory() as s:
                    await ensure_auth_tables(s)
                    pw_hash = hash_password("testpass123")
                    await s.execute(
                        sa_text(
                            "INSERT INTO _pqdb_users (id, email, password_hash, role) "
                            "VALUES (:id, :email, :pw, 'authenticated')"
                        ),
                        {
                            "id": str(user_id),
                            "email": "test@example.com",
                            "pw": pw_hash,
                        },
                    )
                    await s.commit()
                await engine.dispose()

            asyncio.get_event_loop().run_until_complete(_setup())

            # Now assign a role via the API
            resp = client.put(
                f"/v1/auth/users/{user_id}/role",
                json={"role": "anon"},
            )
            assert resp.status_code == 200
            assert "anon" in resp.json()["message"]

    def test_anon_key_cannot_assign_role(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_id,
            project_id=project_id,
        )
        with TestClient(app) as client:
            resp = client.put(
                f"/v1/auth/users/{user_id}/role",
                json={"role": "authenticated"},
            )
            assert resp.status_code == 403

    def test_assign_nonexistent_role_returns_400(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = _make_rls_app(
            test_db_url,
            key_role="service",
            user_id=user_id,
            project_id=project_id,
        )
        with TestClient(app) as client:
            resp = client.put(
                f"/v1/auth/users/{user_id}/role",
                json={"role": "nonexistent_role"},
            )
            assert resp.status_code == 400
            assert "does not exist" in resp.json()["detail"]


class TestPolicyBasedRlsEnforcement:
    """RLS enforcement uses policies when they exist for a table."""

    def test_policy_all_allows_unrestricted_select(self, test_db_url: str) -> None:
        """authenticated role with 'all' condition can see all rows."""
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        project_id = uuid.uuid4()

        # Service creates table and inserts rows
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
            # Create policy: authenticated can select all
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select_all",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "all",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        # User A (authenticated) should see ALL rows
        auth_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_a,
            user_role="authenticated",
            project_id=project_id,
        )
        with TestClient(auth_app) as auth_client:
            resp = auth_client.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 2

    def test_policy_owner_restricts_to_own_rows(self, test_db_url: str) -> None:
        """authenticated role with 'owner' condition sees only own rows."""
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
            # Create policy: authenticated can select own rows only
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select_own",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "owner",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        # User A sees only own rows
        auth_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_a,
            user_role="authenticated",
            project_id=project_id,
        )
        with TestClient(auth_app) as auth_client:
            resp = auth_client.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["title"] == "A item"

    def test_policy_none_denies_access(self, test_db_url: str) -> None:
        """anon role with 'none' condition is denied access."""
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={"rows": [{"title": "Secret", "user_id": str(uuid.uuid4())}]},
            )
            # Create policy: anon cannot select
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "anon_no_select",
                    "operation": "select",
                    "role": "anon",
                    "condition": "none",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        # Anon user (no user context) gets 403
        anon_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=None,
            user_role="anon",
            project_id=project_id,
        )
        with TestClient(anon_app) as anon_client:
            resp = anon_client.post("/v1/db/items/select", json={})
            assert resp.status_code == 403

    def test_no_policy_for_role_denies_access(self, test_db_url: str) -> None:
        """When policies exist for a table but not for the user's role, deny."""
        user_a = uuid.uuid4()
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            # Create policy for authenticated only — no anon policy
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select_all",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "all",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        # anon role has no policy => denied
        anon_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_a,
            user_role="anon",
            project_id=project_id,
        )
        with TestClient(anon_app) as anon_client:
            resp = anon_client.post("/v1/db/items/select", json={})
            assert resp.status_code == 403

    def test_service_role_bypasses_policies(self, test_db_url: str) -> None:
        """Service role always has admin access regardless of policies."""
        project_id = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={
                    "rows": [
                        {"title": "A item", "user_id": str(uuid.uuid4())},
                        {"title": "B item", "user_id": str(uuid.uuid4())},
                    ]
                },
            )
            # Create restrictive policy that should not apply to service
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "anon_no_select",
                    "operation": "select",
                    "role": "anon",
                    "condition": "none",
                },
                headers={"Authorization": "Bearer dummy"},
            )

            # Service role still sees all rows
            resp = svc.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            assert len(resp.json()["data"]) == 2

    def test_no_policies_falls_back_to_basic_rls(self, test_db_url: str) -> None:
        """When no policies exist for a table, use basic owner-column RLS."""
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
            # No policies created — basic RLS should apply

        # User A with anon key sees only own rows (basic RLS)
        anon_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_a,
            user_role="authenticated",
            project_id=project_id,
        )
        with TestClient(anon_app) as anon_client:
            resp = anon_client.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["title"] == "A item"


class TestMultiRolePolicyEnforcement:
    """Multi-role scenario: user sees own, anon denied, service all."""

    def test_multi_role_scenario(self, test_db_url: str) -> None:
        user_admin = uuid.uuid4()
        user_mod = uuid.uuid4()
        user_normal = uuid.uuid4()
        project_id = uuid.uuid4()

        # Service role sets up everything
        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)

            # Insert rows for different users
            svc.post(
                "/v1/db/items/insert",
                json={
                    "rows": [
                        {"title": "Admin item", "user_id": str(user_admin)},
                        {"title": "Mod item", "user_id": str(user_mod)},
                        {"title": "User item", "user_id": str(user_normal)},
                    ]
                },
            )

            # Create policies:
            # authenticated => owner (sees own rows)
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_select_own",
                    "operation": "select",
                    "role": "authenticated",
                    "condition": "owner",
                },
                headers={"Authorization": "Bearer dummy"},
            )
            # anon => none (no select access)
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "anon_no_select",
                    "operation": "select",
                    "role": "anon",
                    "condition": "none",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        # Normal user sees only own row
        normal_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_normal,
            user_role="authenticated",
            project_id=project_id,
        )
        with TestClient(normal_app) as normal_client:
            resp = normal_client.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["title"] == "User item"

        # Anon user is denied
        anon_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=None,
            user_role="anon",
            project_id=project_id,
        )
        with TestClient(anon_app) as anon_client:
            resp = anon_client.post("/v1/db/items/select", json={})
            assert resp.status_code == 403

        # Service role sees all
        with TestClient(svc_app) as svc:
            resp = svc.post("/v1/db/items/select", json={})
            assert resp.status_code == 200
            assert len(resp.json()["data"]) == 3


class TestPolicyBasedUpdateDelete:
    """Policy enforcement on update and delete operations."""

    def test_policy_none_denies_update(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        user_a = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={"rows": [{"title": "Item A", "user_id": str(user_a)}]},
            )
            # anon cannot update
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "anon_no_update",
                    "operation": "update",
                    "role": "anon",
                    "condition": "none",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        anon_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_a,
            user_role="anon",
            project_id=project_id,
        )
        with TestClient(anon_app) as anon_client:
            resp = anon_client.post(
                "/v1/db/items/update",
                json={
                    "values": {"title": "Modified"},
                    "filters": [{"column": "title", "op": "eq", "value": "Item A"}],
                },
            )
            assert resp.status_code == 403

    def test_policy_none_denies_delete(self, test_db_url: str) -> None:
        project_id = uuid.uuid4()
        user_a = uuid.uuid4()

        svc_app = _make_rls_app(test_db_url, key_role="service", project_id=project_id)
        with TestClient(svc_app) as svc:
            _create_owner_table(svc)
            svc.post(
                "/v1/db/items/insert",
                json={"rows": [{"title": "Item A", "user_id": str(user_a)}]},
            )
            # anon cannot delete
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "anon_no_delete",
                    "operation": "delete",
                    "role": "anon",
                    "condition": "none",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        anon_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_a,
            user_role="anon",
            project_id=project_id,
        )
        with TestClient(anon_app) as anon_client:
            resp = anon_client.post(
                "/v1/db/items/delete",
                json={"filters": [{"column": "title", "op": "eq", "value": "Item A"}]},
            )
            assert resp.status_code == 403

    def test_policy_owner_allows_update_own_rows(self, test_db_url: str) -> None:
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
            # authenticated can update own rows
            svc.post(
                "/v1/db/tables/items/policies",
                json={
                    "name": "auth_update_own",
                    "operation": "update",
                    "role": "authenticated",
                    "condition": "owner",
                },
                headers={"Authorization": "Bearer dummy"},
            )

        # User A updates own row
        auth_app = _make_rls_app(
            test_db_url,
            key_role="anon",
            user_id=user_a,
            user_role="authenticated",
            project_id=project_id,
        )
        with TestClient(auth_app) as auth_client:
            resp = auth_client.post(
                "/v1/db/items/update",
                json={
                    "values": {"title": "Updated A"},
                    "filters": [{"column": "title", "op": "eq", "value": "A item"}],
                },
            )
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["title"] == "Updated A"

        # Verify B's item is untouched
        with TestClient(svc_app) as svc:
            resp = svc.post(
                "/v1/db/items/select",
                json={"filters": [{"column": "title", "op": "eq", "value": "B item"}]},
            )
            assert len(resp.json()["data"]) == 1


class TestHealthCheck:
    """Health check still works with new routes."""

    def test_health_returns_200(self, test_db_url: str) -> None:
        app = _make_rls_app(test_db_url, key_role="service")
        with TestClient(app) as client:
            resp = client.get("/health")
            assert resp.status_code == 200
