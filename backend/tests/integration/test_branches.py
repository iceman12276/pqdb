"""Integration tests for branch CRUD endpoints.

Boots the real FastAPI app with a real Postgres database,
exercises create -> list -> delete branch flow with auth.
The provisioner and branch DB creation are mocked to avoid
needing a real Postgres superuser for branching.
"""

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.branches import router as branches_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_mldsa65_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient
from tests.integration.conftest import (
    auth_headers,
    create_project,
    signup_and_get_token,
)


def _make_branch_app(test_db_url: str) -> FastAPI:
    """Build a test FastAPI app with branch endpoints."""
    private_key, public_key = generate_mldsa65_keypair()

    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        return make_database_name(project_id)

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    mock_vault = MagicMock(spec=VaultClient)

    def _mock_store(project_id: uuid.UUID, key: bytes) -> None:
        pass

    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store)

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

        app.dependency_overrides[get_session] = _override_get_session
        app.state.mldsa65_private_key = private_key
        app.state.mldsa65_public_key = public_key
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(branches_router)
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_branch_app(test_db_url)
    with TestClient(app) as c:
        yield c


def _setup_project(client: TestClient) -> tuple[str, str]:
    """Helper: sign up and create a project. Returns (token, project_id)."""
    token = signup_and_get_token(client)
    project = create_project(client, token)
    return token, project["id"]


class TestBranchRoutesExist:
    """Verify branch routes are registered and return non-404."""

    def test_create_branch_route_exists(self, client: TestClient) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/branches",
            json={"name": "test"},
        )
        assert resp.status_code != 404

    def test_list_branches_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/branches")
        assert resp.status_code != 404

    def test_delete_branch_route_exists(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}/branches/test")
        assert resp.status_code != 404


class TestBranchAuth:
    """All branch endpoints require valid JWT."""

    def test_create_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/branches",
            json={"name": "test"},
        )
        assert resp.status_code in (401, 403)

    def test_list_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}/branches")
        assert resp.status_code in (401, 403)

    def test_delete_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}/branches/test")
        assert resp.status_code in (401, 403)


class TestCreateBranch:
    """Tests for POST /v1/projects/{id}/branches."""

    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_create_branch_success(
        self, mock_create: AsyncMock, client: TestClient
    ) -> None:
        token, project_id = _setup_project(client)
        resp = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "staging"
        assert data["database_name"].startswith("pqdb_branch_")
        assert data["status"] == "active"
        assert "id" in data
        assert "created_at" in data

    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_create_branch_response_format(
        self, mock_create: AsyncMock, client: TestClient
    ) -> None:
        token, project_id = _setup_project(client)
        resp = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "dev"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        # Verify all required fields
        required = {"id", "name", "database_name", "status", "created_at"}
        assert required.issubset(data.keys())

    def test_create_branch_invalid_name_returns_422(self, client: TestClient) -> None:
        token, project_id = _setup_project(client)
        resp = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "INVALID"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    def test_create_branch_reserved_name_returns_422(self, client: TestClient) -> None:
        token, project_id = _setup_project(client)
        resp = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "main"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 422

    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_create_duplicate_branch_returns_409(
        self, mock_create: AsyncMock, client: TestClient
    ) -> None:
        token, project_id = _setup_project(client)
        # Create first
        resp1 = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        assert resp1.status_code == 201
        # Try duplicate
        resp2 = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        assert resp2.status_code == 409
        assert "BRANCH_EXISTS" in str(resp2.json())

    def test_create_branch_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client)
        resp = client.post(
            f"/v1/projects/{uuid.uuid4()}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestBranchLimit:
    """Tests for max 5 branches per project enforcement."""

    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_max_5_branches_enforced(
        self, mock_create: AsyncMock, client: TestClient
    ) -> None:
        token, project_id = _setup_project(client)
        # Create 5 branches
        for i in range(5):
            resp = client.post(
                f"/v1/projects/{project_id}/branches",
                json={"name": f"branch-{i}"},
                headers=auth_headers(token),
            )
            assert resp.status_code == 201, f"Branch {i} failed: {resp.json()}"

        # 6th should fail
        resp = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "branch-overflow"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 409
        assert "BRANCH_LIMIT_EXCEEDED" in str(resp.json())


class TestListBranches:
    """Tests for GET /v1/projects/{id}/branches."""

    def test_list_branches_empty(self, client: TestClient) -> None:
        token, project_id = _setup_project(client)
        resp = client.get(
            f"/v1/projects/{project_id}/branches",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json() == []

    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_list_branches_returns_created(
        self, mock_create: AsyncMock, client: TestClient
    ) -> None:
        token, project_id = _setup_project(client)
        # Create two branches
        client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "dev"},
            headers=auth_headers(token),
        )
        resp = client.get(
            f"/v1/projects/{project_id}/branches",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        branches = resp.json()
        assert len(branches) == 2
        names = {b["name"] for b in branches}
        assert names == {"staging", "dev"}

    def test_list_branches_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}/branches",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestDeleteBranch:
    """Tests for DELETE /v1/projects/{id}/branches/{name}."""

    @patch("pqdb_api.routes.branches.drop_branch_database", new_callable=AsyncMock)
    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_delete_branch_success(
        self,
        mock_create: AsyncMock,
        mock_drop: AsyncMock,
        client: TestClient,
    ) -> None:
        token, project_id = _setup_project(client)
        # Create
        client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        # Delete
        resp = client.delete(
            f"/v1/projects/{project_id}/branches/staging",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"

    @patch("pqdb_api.routes.branches.drop_branch_database", new_callable=AsyncMock)
    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_delete_branch_removes_from_list(
        self,
        mock_create: AsyncMock,
        mock_drop: AsyncMock,
        client: TestClient,
    ) -> None:
        token, project_id = _setup_project(client)
        # Create
        client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        # Delete
        client.delete(
            f"/v1/projects/{project_id}/branches/staging",
            headers=auth_headers(token),
        )
        # List should be empty
        resp = client.get(
            f"/v1/projects/{project_id}/branches",
            headers=auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json() == []

    def test_delete_nonexistent_branch_returns_404(self, client: TestClient) -> None:
        token, project_id = _setup_project(client)
        resp = client.delete(
            f"/v1/projects/{project_id}/branches/nonexistent",
            headers=auth_headers(token),
        )
        assert resp.status_code == 404


class TestFullBranchFlow:
    """End-to-end: create project -> create branch -> list -> delete."""

    @patch("pqdb_api.routes.branches.drop_branch_database", new_callable=AsyncMock)
    @patch("pqdb_api.routes.branches.create_branch_database", new_callable=AsyncMock)
    def test_complete_branch_crud_flow(
        self,
        mock_create: AsyncMock,
        mock_drop: AsyncMock,
        client: TestClient,
    ) -> None:
        # 1. Sign up and create project
        token = signup_and_get_token(client, email="branch-flow@test.com")
        project = create_project(client, token)
        project_id = project["id"]

        # 2. Create a branch
        create_resp = client.post(
            f"/v1/projects/{project_id}/branches",
            json={"name": "staging"},
            headers=auth_headers(token),
        )
        assert create_resp.status_code == 201
        branch = create_resp.json()
        assert branch["name"] == "staging"
        assert branch["status"] == "active"
        assert branch["database_name"].startswith("pqdb_branch_")

        # 3. List branches — should have one
        list_resp = client.get(
            f"/v1/projects/{project_id}/branches",
            headers=auth_headers(token),
        )
        assert list_resp.status_code == 200
        assert len(list_resp.json()) == 1

        # 4. Delete the branch
        del_resp = client.delete(
            f"/v1/projects/{project_id}/branches/staging",
            headers=auth_headers(token),
        )
        assert del_resp.status_code == 200
        assert del_resp.json()["status"] == "deleted"

        # 5. List should now be empty
        list_resp2 = client.get(
            f"/v1/projects/{project_id}/branches",
            headers=auth_headers(token),
        )
        assert list_resp2.status_code == 200
        assert len(list_resp2.json()) == 0
