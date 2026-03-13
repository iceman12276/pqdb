"""Integration tests for project CRUD endpoints.

Boots the real FastAPI app with an in-process SQLite database,
exercises create -> list -> get -> delete project flow with auth.
"""

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import StaticPool, event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.database import get_session
from pqdb_api.models.base import Base
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_ed25519_keypair


def _create_test_app() -> FastAPI:
    """Create a test FastAPI app with in-memory SQLite."""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, connection_record):  # type: ignore[no-untyped-def]
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    test_session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        async with test_session_factory() as session:
            yield session

    private_key, public_key = generate_ed25519_keypair()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.dependency_overrides[get_session] = _override_get_session
    return app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = _create_test_app()
    with TestClient(app) as c:
        yield c


def _signup_and_get_token(client: TestClient, email: str = "dev@test.com") -> str:
    """Sign up a developer and return the access token."""
    resp = client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "testpass123"},
    )
    assert resp.status_code == 201
    token: str = resp.json()["access_token"]
    return token


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class TestProjectRoutesExist:
    """Verify all project routes are registered and return non-404."""

    def test_create_project_route_exists(self, client: TestClient) -> None:
        resp = client.post("/v1/projects", json={"name": "test"})
        assert resp.status_code != 404

    def test_list_projects_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/projects")
        assert resp.status_code != 404

    def test_get_project_route_exists(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code != 404

    def test_delete_project_route_exists(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code != 404


class TestProjectAuth:
    """All project endpoints require valid JWT."""

    def test_create_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.post("/v1/projects", json={"name": "test"})
        assert resp.status_code in (401, 403)

    def test_list_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get("/v1/projects")
        assert resp.status_code in (401, 403)

    def test_get_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.get(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code in (401, 403)

    def test_delete_without_auth_returns_401_or_403(self, client: TestClient) -> None:
        resp = client.delete(f"/v1/projects/{uuid.uuid4()}")
        assert resp.status_code in (401, 403)


class TestCreateProject:
    """Tests for POST /v1/projects."""

    def test_create_project_success(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "my-project"},
            headers=_auth_headers(token),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "my-project"
        assert data["region"] == "us-east-1"
        assert data["status"] == "active"
        assert "id" in data
        assert "created_at" in data

    def test_create_project_with_region(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={"name": "eu-project", "region": "eu-west-1"},
            headers=_auth_headers(token),
        )
        assert resp.status_code == 201
        assert resp.json()["region"] == "eu-west-1"

    def test_create_project_missing_name_returns_422(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.post(
            "/v1/projects",
            json={},
            headers=_auth_headers(token),
        )
        assert resp.status_code == 422


class TestListProjects:
    """Tests for GET /v1/projects."""

    def test_list_projects_empty(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.get("/v1/projects", headers=_auth_headers(token))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_projects_returns_own_projects(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        client.post(
            "/v1/projects",
            json={"name": "proj-1"},
            headers=_auth_headers(token),
        )
        client.post(
            "/v1/projects",
            json={"name": "proj-2"},
            headers=_auth_headers(token),
        )
        resp = client.get("/v1/projects", headers=_auth_headers(token))
        assert resp.status_code == 200
        projects = resp.json()
        assert len(projects) == 2
        names = {p["name"] for p in projects}
        assert names == {"proj-1", "proj-2"}

    def test_list_projects_does_not_include_other_developers(
        self, client: TestClient
    ) -> None:
        token_a = _signup_and_get_token(client, email="dev-a@test.com")
        token_b = _signup_and_get_token(client, email="dev-b@test.com")

        client.post(
            "/v1/projects",
            json={"name": "a-project"},
            headers=_auth_headers(token_a),
        )
        client.post(
            "/v1/projects",
            json={"name": "b-project"},
            headers=_auth_headers(token_b),
        )

        resp_a = client.get("/v1/projects", headers=_auth_headers(token_a))
        assert resp_a.status_code == 200
        assert len(resp_a.json()) == 1
        assert resp_a.json()[0]["name"] == "a-project"

    def test_list_projects_excludes_archived(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "to-archive"},
            headers=_auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        # Delete (archive) the project
        client.delete(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )

        resp = client.get("/v1/projects", headers=_auth_headers(token))
        assert resp.status_code == 200
        assert len(resp.json()) == 0


class TestGetProject:
    """Tests for GET /v1/projects/{id}."""

    def test_get_project_success(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "detail-project"},
            headers=_auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == project_id
        assert data["name"] == "detail-project"

    def test_get_nonexistent_project_returns_404(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        resp = client.get(
            f"/v1/projects/{uuid.uuid4()}",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 404

    def test_get_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = _signup_and_get_token(client, email="owner@test.com")
        token_b = _signup_and_get_token(client, email="intruder@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "private-project"},
            headers=_auth_headers(token_a),
        )
        project_id = create_resp.json()["id"]

        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestDeleteProject:
    """Tests for DELETE /v1/projects/{id}."""

    def test_delete_project_success(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "to-delete"},
            headers=_auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "archived"

    def test_delete_project_is_soft_delete(self, client: TestClient) -> None:
        token = _signup_and_get_token(client)
        create_resp = client.post(
            "/v1/projects",
            json={"name": "soft-delete"},
            headers=_auth_headers(token),
        )
        project_id = create_resp.json()["id"]

        client.delete(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )

        # Project should still be retrievable by ID (just archived)
        resp = client.get(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "archived"

    def test_delete_nonexistent_project_returns_404(
        self, client: TestClient
    ) -> None:
        token = _signup_and_get_token(client)
        resp = client.delete(
            f"/v1/projects/{uuid.uuid4()}",
            headers=_auth_headers(token),
        )
        assert resp.status_code == 404

    def test_delete_other_developers_project_returns_404(
        self, client: TestClient
    ) -> None:
        token_a = _signup_and_get_token(client, email="delowner@test.com")
        token_b = _signup_and_get_token(client, email="delintruder@test.com")

        create_resp = client.post(
            "/v1/projects",
            json={"name": "not-yours"},
            headers=_auth_headers(token_a),
        )
        project_id = create_resp.json()["id"]

        resp = client.delete(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token_b),
        )
        assert resp.status_code == 404


class TestHealthCheck:
    """Health check still works with project routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200


class TestFullProjectFlow:
    """End-to-end: signup -> create project -> list -> get -> delete."""

    def test_complete_crud_flow(self, client: TestClient) -> None:
        # 1. Sign up
        token = _signup_and_get_token(client, email="crud@test.com")

        # 2. Create project
        create_resp = client.post(
            "/v1/projects",
            json={"name": "flow-project", "region": "ap-southeast-1"},
            headers=_auth_headers(token),
        )
        assert create_resp.status_code == 201
        project = create_resp.json()
        project_id = project["id"]
        assert project["name"] == "flow-project"
        assert project["region"] == "ap-southeast-1"
        assert project["status"] == "active"

        # 3. List projects - should include the new one
        list_resp = client.get("/v1/projects", headers=_auth_headers(token))
        assert list_resp.status_code == 200
        assert len(list_resp.json()) == 1

        # 4. Get project by ID
        get_resp = client.get(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )
        assert get_resp.status_code == 200
        assert get_resp.json()["name"] == "flow-project"

        # 5. Delete (archive) project
        del_resp = client.delete(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )
        assert del_resp.status_code == 200
        assert del_resp.json()["status"] == "archived"

        # 6. List should now be empty (archived projects excluded)
        list_resp2 = client.get("/v1/projects", headers=_auth_headers(token))
        assert list_resp2.status_code == 200
        assert len(list_resp2.json()) == 0

        # 7. Get by ID still returns (with archived status)
        get_resp2 = client.get(
            f"/v1/projects/{project_id}",
            headers=_auth_headers(token),
        )
        assert get_resp2.status_code == 200
        assert get_resp2.json()["status"] == "archived"
