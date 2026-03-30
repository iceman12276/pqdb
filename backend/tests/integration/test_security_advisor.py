"""Integration tests for Security Advisor endpoint (US-102).

Boots the real FastAPI app with a real Postgres database.
Tests verify that security findings are correctly returned
based on actual table/column/policy state.
"""

from __future__ import annotations

import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.middleware.user_auth import get_current_user
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.security_advisor import router as security_advisor_router
from tests.integration.conftest import PG_HOST, PG_PORT, PG_USER, _pg_env


def _make_security_advisor_app(test_db_url: str) -> FastAPI:
    """Build a test app with security advisor + db routes.

    Uses the same test DB for both "project" and "platform" sessions,
    since integration tests run in a single Postgres database.
    """
    project_id = uuid.uuid4()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        async def _override_project_context() -> ProjectContext:
            return ProjectContext(
                project_id=project_id,
                key_role="service",
                database_name="test",
            )

        async def _override_current_user() -> None:
            return None

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_project_session] = _override_get_project_session
        app.dependency_overrides[get_project_context] = _override_project_context
        app.dependency_overrides[get_current_user] = _override_current_user
        app.dependency_overrides[get_session] = _override_get_session
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(db_router)
    app.include_router(security_advisor_router)
    return app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_security_advisor_app(test_db_url)
    with TestClient(app) as c:
        yield c


def _create_table(
    client: TestClient,
    name: str,
    columns: list[dict[str, Any]],
) -> None:
    """Helper to create a table via the DB route."""
    resp = client.post(
        "/v1/db/tables",
        json={"name": name, "columns": columns},
    )
    assert resp.status_code == 201, f"Failed to create table: {resp.text}"


def _exec_sql(test_db_name: str, sql: str) -> None:
    """Execute raw SQL against the test database via psql."""
    env = _pg_env()
    subprocess.run(
        [
            "psql",
            "-h",
            PG_HOST,
            "-p",
            str(PG_PORT),
            "-U",
            PG_USER,
            "-d",
            test_db_name,
            "-c",
            sql,
        ],
        env=env,
        check=True,
        capture_output=True,
    )


class TestSecurityAdvisorRouteExists:
    """Verify the route is registered and returns 200."""

    def test_route_returns_200(self, client: TestClient) -> None:
        resp = client.get("/v1/db/advisor/security")
        assert resp.status_code == 200

    def test_returns_list(self, client: TestClient) -> None:
        resp = client.get("/v1/db/advisor/security")
        assert isinstance(resp.json(), list)


class TestPlainEmailFinding:
    """AC #9: create table with plain email column, verify finding returned."""

    def test_plain_email_returns_pii_finding(self, client: TestClient) -> None:
        _create_table(
            client,
            "contacts",
            [
                {"name": "name", "data_type": "text", "sensitivity": "plain"},
                {"name": "email", "data_type": "text", "sensitivity": "plain"},
            ],
        )

        resp = client.get("/v1/db/advisor/security")
        assert resp.status_code == 200
        findings = resp.json()

        pii_findings = [f for f in findings if f["rule_id"] == "plain-pii"]
        assert len(pii_findings) >= 1
        email_finding = [f for f in pii_findings if "email" in f["message"]]
        assert len(email_finding) == 1
        assert email_finding[0]["severity"] == "warning"
        assert email_finding[0]["category"] == "data-protection"
        assert email_finding[0]["table"] == "contacts"
        assert email_finding[0]["suggestion"] is not None

    def test_encrypted_email_no_pii_finding(self, client: TestClient) -> None:
        """No plain-pii finding when email is searchable."""
        _create_table(
            client,
            "users",
            [
                {"name": "name", "data_type": "text", "sensitivity": "plain"},
                {"name": "email", "data_type": "text", "sensitivity": "searchable"},
            ],
        )

        resp = client.get("/v1/db/advisor/security")
        findings = resp.json()
        pii_findings = [f for f in findings if f["rule_id"] == "plain-pii"]
        email_pii = [f for f in pii_findings if "email" in f["message"]]
        assert email_pii == []


class TestRlsFinding:
    """AC #10: create table with RLS policy, verify no 'no RLS' finding."""

    def test_table_without_rls_returns_finding(self, client: TestClient) -> None:
        _create_table(
            client,
            "posts",
            [{"name": "title", "data_type": "text", "sensitivity": "plain"}],
        )

        resp = client.get("/v1/db/advisor/security")
        findings = resp.json()
        rls_findings = [f for f in findings if f["rule_id"] == "no-rls"]
        assert len(rls_findings) >= 1
        assert any(f["table"] == "posts" for f in rls_findings)

    def test_table_with_rls_no_finding(
        self,
        client: TestClient,
        test_db_name: str,
    ) -> None:
        """When a table has an RLS policy, no 'no-rls' finding for it."""
        _create_table(
            client,
            "secure_data",
            [{"name": "value", "data_type": "text", "sensitivity": "plain"}],
        )

        # Enable RLS and create a policy via psql
        _exec_sql(
            test_db_name,
            "ALTER TABLE secure_data ENABLE ROW LEVEL SECURITY; "
            "CREATE POLICY secure_data_pol ON secure_data FOR ALL USING (true);",
        )

        resp = client.get("/v1/db/advisor/security")
        findings = resp.json()
        rls_findings = [f for f in findings if f["rule_id"] == "no-rls"]
        secure_data_findings = [f for f in rls_findings if f["table"] == "secure_data"]
        assert secure_data_findings == []


class TestNoOwnerFinding:
    """Verify no-owner finding for tables without owner columns."""

    def test_table_without_owner_returns_finding(self, client: TestClient) -> None:
        _create_table(
            client,
            "items",
            [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
                {"name": "price", "data_type": "integer", "sensitivity": "plain"},
            ],
        )

        resp = client.get("/v1/db/advisor/security")
        findings = resp.json()
        owner_findings = [f for f in findings if f["rule_id"] == "no-owner"]
        assert any(f["table"] == "items" for f in owner_findings)

    def test_table_with_owner_id_no_finding(self, client: TestClient) -> None:
        _create_table(
            client,
            "tasks",
            [
                {"name": "title", "data_type": "text", "sensitivity": "plain"},
                {"name": "owner_id", "data_type": "text", "sensitivity": "plain"},
            ],
        )

        resp = client.get("/v1/db/advisor/security")
        findings = resp.json()
        owner_findings = [f for f in findings if f["rule_id"] == "no-owner"]
        tasks_findings = [f for f in owner_findings if f["table"] == "tasks"]
        assert tasks_findings == []


class TestFindingShape:
    """Verify the shape of returned findings matches the AC."""

    def test_finding_has_required_fields(self, client: TestClient) -> None:
        _create_table(
            client,
            "profiles",
            [{"name": "email", "data_type": "text", "sensitivity": "plain"}],
        )

        resp = client.get("/v1/db/advisor/security")
        findings = resp.json()
        assert len(findings) > 0

        required_keys = {
            "rule_id",
            "severity",
            "category",
            "title",
            "message",
            "table",
            "suggestion",
        }
        for finding in findings:
            assert required_keys <= set(finding.keys()), (
                f"Missing keys: {required_keys - set(finding.keys())}"
            )


class TestEmptyProject:
    """Verify advisor works on a project with no tables."""

    def test_no_tables_returns_empty(self, client: TestClient) -> None:
        resp = client.get("/v1/db/advisor/security")
        assert resp.status_code == 200
        assert resp.json() == []
