"""Integration tests for schema migrations — add/drop column (US-014).

Boots the real FastAPI app with a real Postgres database.
The project session dependency is overridden to use the same test
Postgres DB, bypassing API key auth (which is tested separately).
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import _make_project_app


@pytest.fixture()
def client(test_db_url: str) -> Iterator[TestClient]:
    app = _make_project_app(test_db_url)
    with TestClient(app) as c:
        yield c


class TestAddColumnRouteExists:
    """Verify add column route is registered."""

    def test_post_columns_route_exists(self, client: TestClient) -> None:
        resp = client.post("/v1/db/tables/anything/columns", json={})
        assert resp.status_code != 404
        assert resp.status_code != 405


class TestAddColumnPlain:
    """Test adding plain columns to an existing table."""

    def _create_table(self, client: TestClient, name: str = "users") -> None:
        resp = client.post(
            "/v1/db/tables",
            json={
                "name": name,
                "columns": [{"name": "name", "data_type": "text"}],
            },
        )
        assert resp.status_code == 201

    def test_add_plain_column_returns_201(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "age", "data_type": "integer", "sensitivity": "plain"},
        )
        assert resp.status_code == 201

    def test_add_plain_column_returns_metadata(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "age", "data_type": "integer", "sensitivity": "plain"},
        )
        data = resp.json()
        assert data["name"] == "age"
        assert data["sensitivity"] == "plain"
        assert data["data_type"] == "integer"

    def test_add_column_appears_in_table_schema(self, client: TestClient) -> None:
        self._create_table(client)
        client.post(
            "/v1/db/tables/users/columns",
            json={"name": "age", "data_type": "integer"},
        )
        resp = client.get("/v1/db/tables/users")
        data = resp.json()
        col_names = [c["name"] for c in data["columns"]]
        assert "age" in col_names

    def test_default_sensitivity_is_plain(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "age", "data_type": "integer"},
        )
        data = resp.json()
        assert data["sensitivity"] == "plain"


class TestAddColumnSensitive:
    """Test adding sensitive columns with shadow column creation."""

    def _create_table(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "users",
                "columns": [{"name": "name", "data_type": "text"}],
            },
        )

    def test_add_private_column(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "ssn", "data_type": "text", "sensitivity": "private"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["sensitivity"] == "private"

    def test_add_searchable_column(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "email", "data_type": "text", "sensitivity": "searchable"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["sensitivity"] == "searchable"

    def test_searchable_column_metadata_recorded(self, client: TestClient) -> None:
        self._create_table(client)
        client.post(
            "/v1/db/tables/users/columns",
            json={"name": "email", "data_type": "text", "sensitivity": "searchable"},
        )
        resp = client.get("/v1/db/tables/users")
        data = resp.json()
        col_map = {c["name"]: c for c in data["columns"]}
        assert "email" in col_map
        assert col_map["email"]["sensitivity"] == "searchable"


class TestAddColumnValidation:
    """Test validation errors for add column."""

    def _create_table(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "users",
                "columns": [{"name": "name", "data_type": "text"}],
            },
        )

    def test_add_column_to_nonexistent_table_returns_404(
        self, client: TestClient
    ) -> None:
        resp = client.post(
            "/v1/db/tables/missing/columns",
            json={"name": "x", "data_type": "text"},
        )
        assert resp.status_code == 404

    def test_add_duplicate_column_returns_409(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "name", "data_type": "text"},
        )
        assert resp.status_code == 409

    def test_invalid_data_type_returns_400(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "evil", "data_type": "text); DROP TABLE users; --"},
        )
        assert resp.status_code == 400

    def test_invalid_sensitivity_returns_422(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "x", "data_type": "text", "sensitivity": "magic"},
        )
        assert resp.status_code == 422

    def test_empty_column_name_returns_400(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "", "data_type": "text"},
        )
        assert resp.status_code == 400

    def test_reserved_column_name_returns_400(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "id", "data_type": "bigint"},
        )
        assert resp.status_code == 400


class TestDropColumnRouteExists:
    """Verify drop column route is registered."""

    def test_delete_columns_route_exists(self, client: TestClient) -> None:
        resp = client.delete("/v1/db/tables/anything/columns/anything")
        # 404 means table/column not found (valid), not route not found
        assert resp.status_code != 405


class TestDropColumn:
    """Test dropping columns from tables."""

    def _create_table_with_columns(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "users",
                "columns": [
                    {"name": "name", "data_type": "text", "sensitivity": "plain"},
                    {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                    {"name": "ssn", "data_type": "text", "sensitivity": "private"},
                ],
            },
        )

    def test_drop_plain_column_returns_204(self, client: TestClient) -> None:
        self._create_table_with_columns(client)
        resp = client.delete("/v1/db/tables/users/columns/name")
        assert resp.status_code == 204

    def test_drop_searchable_column_returns_204(self, client: TestClient) -> None:
        self._create_table_with_columns(client)
        resp = client.delete("/v1/db/tables/users/columns/email")
        assert resp.status_code == 204

    def test_drop_private_column_returns_204(self, client: TestClient) -> None:
        self._create_table_with_columns(client)
        resp = client.delete("/v1/db/tables/users/columns/ssn")
        assert resp.status_code == 204

    def test_dropped_column_removed_from_schema(self, client: TestClient) -> None:
        self._create_table_with_columns(client)
        client.delete("/v1/db/tables/users/columns/email")
        resp = client.get("/v1/db/tables/users")
        data = resp.json()
        col_names = [c["name"] for c in data["columns"]]
        assert "email" not in col_names
        assert "name" in col_names  # other columns remain

    def test_drop_and_readd_column(self, client: TestClient) -> None:
        self._create_table_with_columns(client)
        client.delete("/v1/db/tables/users/columns/name")
        # Re-add with different sensitivity
        resp = client.post(
            "/v1/db/tables/users/columns",
            json={"name": "name", "data_type": "text", "sensitivity": "private"},
        )
        assert resp.status_code == 201
        assert resp.json()["sensitivity"] == "private"


class TestDropColumnValidation:
    """Test validation errors for drop column."""

    def _create_table(self, client: TestClient) -> None:
        client.post(
            "/v1/db/tables",
            json={
                "name": "users",
                "columns": [{"name": "name", "data_type": "text"}],
            },
        )

    def test_drop_from_nonexistent_table_returns_404(self, client: TestClient) -> None:
        resp = client.delete("/v1/db/tables/missing/columns/x")
        assert resp.status_code == 404

    def test_drop_nonexistent_column_returns_404(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.delete("/v1/db/tables/users/columns/missing")
        assert resp.status_code == 404

    def test_drop_id_column_returns_400(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.delete("/v1/db/tables/users/columns/id")
        assert resp.status_code == 400

    def test_drop_created_at_column_returns_400(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.delete("/v1/db/tables/users/columns/created_at")
        assert resp.status_code == 400

    def test_drop_updated_at_column_returns_400(self, client: TestClient) -> None:
        self._create_table(client)
        resp = client.delete("/v1/db/tables/users/columns/updated_at")
        assert resp.status_code == 400


class TestHealthStillWorks:
    """Platform health check still works with migration routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
