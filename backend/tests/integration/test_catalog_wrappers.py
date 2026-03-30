"""Integration tests for foreign data wrappers introspection (US-109).

Boots the real FastAPI app with a real Postgres database.
The project session dependency is overridden to use the same
test Postgres DB, bypassing API key auth. Tests verify that
the /v1/db/catalog/wrappers endpoint returns accurate metadata
about foreign data wrappers, servers, and foreign tables.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import _make_project_app

from pqdb_api.routes.introspection import router as introspection_router


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_project_app(test_db_url)
    app.include_router(introspection_router)
    with TestClient(app) as c:
        yield c


class TestWrappersRouteExists:
    """Verify the /v1/db/catalog/wrappers route is registered."""

    def test_wrappers_route_exists(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        assert resp.status_code != 404
        assert resp.status_code != 405


class TestWrappersEmpty:
    """Test GET /v1/db/catalog/wrappers with no FDW configured."""

    def test_returns_empty_structure(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        assert resp.status_code == 200
        data = resp.json()
        assert "wrappers" in data
        assert "servers" in data
        assert "tables" in data
        assert isinstance(data["wrappers"], list)
        assert isinstance(data["servers"], list)
        assert isinstance(data["tables"], list)

    def test_empty_wrappers_list(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        assert data["wrappers"] == []

    def test_empty_servers_list(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        assert data["servers"] == []

    def test_empty_tables_list(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        assert data["tables"] == []


class TestWrappersWithData:
    """Test GET /v1/db/catalog/wrappers after installing FDW extension."""

    @pytest.fixture(autouse=True)
    def _setup_fdw(self, client: TestClient, test_db_url: str) -> Iterator[None]:
        """Install postgres_fdw and create a foreign server + table."""
        import subprocess

        from tests.integration.conftest import PG_HOST, PG_PASS, PG_PORT, PG_USER

        # Extract db name from URL
        db_name = test_db_url.rsplit("/", 1)[-1]
        env = {
            "PGHOST": PG_HOST,
            "PGPORT": str(PG_PORT),
            "PGUSER": PG_USER,
            "PGPASSWORD": PG_PASS,
        }

        setup_sql = """
            CREATE EXTENSION IF NOT EXISTS postgres_fdw;
            CREATE SERVER IF NOT EXISTS test_remote
                FOREIGN DATA WRAPPER postgres_fdw
                OPTIONS (host 'localhost', port '5432', dbname 'postgres');
            CREATE USER MAPPING IF NOT EXISTS FOR CURRENT_USER
                SERVER test_remote
                OPTIONS (user 'postgres', password 'postgres');
            DROP FOREIGN TABLE IF EXISTS remote_items;
            CREATE FOREIGN TABLE remote_items (
                id integer,
                name text
            ) SERVER test_remote
              OPTIONS (schema_name 'pg_catalog', table_name 'pg_type');
        """
        subprocess.run(
            ["psql", "-h", PG_HOST, "-p", str(PG_PORT), "-U", PG_USER,
             "-d", db_name, "-c", setup_sql],
            env=env,
            check=True,
            capture_output=True,
        )

        yield

        teardown_sql = """
            DROP FOREIGN TABLE IF EXISTS remote_items;
            DROP USER MAPPING IF EXISTS FOR CURRENT_USER SERVER test_remote;
            DROP SERVER IF EXISTS test_remote;
            DROP EXTENSION IF EXISTS postgres_fdw CASCADE;
        """
        subprocess.run(
            ["psql", "-h", PG_HOST, "-p", str(PG_PORT), "-U", PG_USER,
             "-d", db_name, "-c", teardown_sql],
            env=env,
            check=False,
            capture_output=True,
        )

    def test_returns_wrapper(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        assert resp.status_code == 200
        data = resp.json()
        wrapper_names = [w["name"] for w in data["wrappers"]]
        assert "postgres_fdw" in wrapper_names

    def test_wrapper_has_handler_and_validator(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        fdw = next(w for w in data["wrappers"] if w["name"] == "postgres_fdw")
        assert "handler" in fdw
        assert "validator" in fdw

    def test_returns_foreign_server(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        server_names = [s["name"] for s in data["servers"]]
        assert "test_remote" in server_names

    def test_server_has_wrapper_and_options(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        srv = next(s for s in data["servers"] if s["name"] == "test_remote")
        assert srv["wrapper"] == "postgres_fdw"
        assert isinstance(srv["options"], list)

    def test_returns_foreign_table(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        table_names = [t["name"] for t in data["tables"]]
        assert "remote_items" in table_names

    def test_foreign_table_has_server_and_schema(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        tbl = next(t for t in data["tables"] if t["name"] == "remote_items")
        assert tbl["server"] == "test_remote"
        assert tbl["schema"] == "public"

    def test_foreign_table_has_columns(self, client: TestClient) -> None:
        resp = client.get("/v1/db/catalog/wrappers")
        data = resp.json()
        tbl = next(t for t in data["tables"] if t["name"] == "remote_items")
        assert isinstance(tbl["columns"], list)
        col_names = [c["name"] for c in tbl["columns"]]
        assert "id" in col_names
        assert "name" in col_names
