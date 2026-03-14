"""Integration tests for CRUD endpoints (US-012).

Boots the real FastAPI app with an in-process SQLite database.
Tests the full insert -> select -> update -> delete round-trip
with blind index (searchable) columns.
"""

from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import StaticPool, event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.middleware.api_key import get_project_session
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router


def _create_test_app() -> FastAPI:
    """Create a minimal test FastAPI app with in-memory SQLite."""
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

    async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
        async with test_session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(health_router)
    app.include_router(db_router)
    app.dependency_overrides[get_project_session] = _override_get_project_session
    return app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = _create_test_app()
    with TestClient(app) as c:
        yield c


def _create_table(client: TestClient) -> None:
    """Helper: create a table with mixed sensitivity columns."""
    resp = client.post(
        "/v1/db/tables",
        json={
            "name": "users",
            "columns": [
                {"name": "display_name", "data_type": "text", "sensitivity": "plain"},
                {"name": "email", "data_type": "text", "sensitivity": "searchable"},
                {"name": "ssn", "data_type": "text", "sensitivity": "private"},
                {"name": "age", "data_type": "integer", "sensitivity": "plain"},
            ],
        },
    )
    assert resp.status_code == 201


# --- Route existence ---


class TestCrudRoutesExist:
    """Verify CRUD routes are registered and respond (not 405)."""

    def test_insert_route_exists(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post("/v1/db/users/insert", json={"rows": []})
        assert resp.status_code != 405

    def test_select_route_exists(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post("/v1/db/users/select", json={})
        assert resp.status_code != 405

    def test_update_route_exists(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/update",
            json={"values": {"display_name": "x"}, "filters": []},
        )
        assert resp.status_code != 405

    def test_delete_route_exists(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post("/v1/db/users/delete", json={"filters": []})
        assert resp.status_code != 405


# --- Insert ---


class TestInsert:
    """Test POST /{table}/insert."""

    def test_insert_plain_columns(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/insert",
            json={"rows": [{"display_name": "Alice", "age": 30}]},
        )
        assert resp.status_code == 201
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["display_name"] == "Alice"
        assert data[0]["age"] == 30

    def test_insert_with_searchable_columns(self, client: TestClient) -> None:
        """Searchable columns: send logical name + _index suffix."""
        _create_table(client)
        resp = client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {
                        "display_name": "Bob",
                        "email": "cipher_email",
                        "email_index": "hmac_hex",
                        "ssn": "cipher_ssn",
                        "age": 25,
                    }
                ]
            },
        )
        assert resp.status_code == 201
        data = resp.json()["data"]
        # Server maps to physical columns
        assert data[0]["email_encrypted"] == "cipher_email"
        assert data[0]["email_index"] == "hmac_hex"
        assert data[0]["ssn_encrypted"] == "cipher_ssn"

    def test_insert_multiple_rows(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {"display_name": "Alice", "age": 30},
                    {"display_name": "Bob", "age": 25},
                ]
            },
        )
        assert resp.status_code == 201
        data = resp.json()["data"]
        assert len(data) == 2

    def test_insert_unknown_column_returns_400(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/insert",
            json={"rows": [{"nonexistent": "value"}]},
        )
        assert resp.status_code == 400
        assert "Unknown column" in resp.json()["detail"]

    def test_insert_empty_rows_returns_400(self, client: TestClient) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/insert",
            json={"rows": []},
        )
        assert resp.status_code == 400

    def test_insert_nonexistent_table_returns_404(self, client: TestClient) -> None:
        _create_table(client)  # Ensures _pqdb_columns exists
        resp = client.post(
            "/v1/db/nonexistent/insert",
            json={"rows": [{"x": 1}]},
        )
        assert resp.status_code == 404

    def test_insert_returns_auto_columns(self, client: TestClient) -> None:
        """Inserted rows should include id, created_at, updated_at."""
        _create_table(client)
        resp = client.post(
            "/v1/db/users/insert",
            json={"rows": [{"display_name": "Alice", "age": 30}]},
        )
        data = resp.json()["data"][0]
        assert "id" in data
        assert "created_at" in data
        assert "updated_at" in data


# --- Select ---


class TestSelect:
    """Test POST /{table}/select."""

    def test_select_all_returns_inserted_data(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={"rows": [{"display_name": "Alice", "age": 30}]},
        )
        resp = client.post("/v1/db/users/select", json={})
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["display_name"] == "Alice"

    def test_select_with_eq_filter_plain(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {"display_name": "Alice", "age": 30},
                    {"display_name": "Bob", "age": 25},
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [
                    {"column": "display_name", "op": "eq", "value": "Alice"}
                ]
            },
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["display_name"] == "Alice"

    def test_select_by_blind_index(self, client: TestClient) -> None:
        """Select using searchable column routes to email_index."""
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {
                        "display_name": "Alice",
                        "email": "cipher1",
                        "email_index": "hmac_alice",
                        "age": 30,
                    },
                    {
                        "display_name": "Bob",
                        "email": "cipher2",
                        "email_index": "hmac_bob",
                        "age": 25,
                    },
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [
                    {"column": "email", "op": "eq", "value": "hmac_alice"}
                ]
            },
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["display_name"] == "Alice"

    def test_select_with_range_filter(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {"display_name": "Alice", "age": 30},
                    {"display_name": "Bob", "age": 25},
                    {"display_name": "Charlie", "age": 35},
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/select",
            json={"filters": [{"column": "age", "op": "gte", "value": 30}]},
        )
        data = resp.json()["data"]
        assert len(data) == 2
        names = {r["display_name"] for r in data}
        assert names == {"Alice", "Charlie"}

    def test_select_with_limit(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {"display_name": "A", "age": 1},
                    {"display_name": "B", "age": 2},
                    {"display_name": "C", "age": 3},
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/select",
            json={"modifiers": {"limit": 2}},
        )
        assert len(resp.json()["data"]) == 2

    def test_select_with_order_by(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {"display_name": "C", "age": 3},
                    {"display_name": "A", "age": 1},
                    {"display_name": "B", "age": 2},
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/select",
            json={"modifiers": {"order_by": "age", "order_dir": "asc"}},
        )
        data = resp.json()["data"]
        ages = [r["age"] for r in data]
        assert ages == [1, 2, 3]

    def test_select_range_on_searchable_returns_400(
        self, client: TestClient
    ) -> None:
        """Range ops on searchable columns should fail."""
        _create_table(client)
        resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [{"column": "email", "op": "gt", "value": "x"}]
            },
        )
        assert resp.status_code == 400

    def test_select_filter_on_private_returns_400(
        self, client: TestClient
    ) -> None:
        """Filtering on private columns should fail."""
        _create_table(client)
        resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [{"column": "ssn", "op": "eq", "value": "x"}]
            },
        )
        assert resp.status_code == 400

    def test_select_unknown_filter_column_returns_400(
        self, client: TestClient
    ) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [
                    {"column": "nonexistent", "op": "eq", "value": "x"}
                ]
            },
        )
        assert resp.status_code == 400

    def test_select_empty_table_returns_empty_data(
        self, client: TestClient
    ) -> None:
        _create_table(client)
        resp = client.post("/v1/db/users/select", json={})
        assert resp.status_code == 200
        assert resp.json()["data"] == []

    def test_select_with_in_filter(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {"display_name": "Alice", "age": 30},
                    {"display_name": "Bob", "age": 25},
                    {"display_name": "Charlie", "age": 35},
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [{"column": "age", "op": "in", "value": [25, 35]}]
            },
        )
        data = resp.json()["data"]
        assert len(data) == 2
        names = {r["display_name"] for r in data}
        assert names == {"Bob", "Charlie"}


# --- Update ---


class TestUpdate:
    """Test POST /{table}/update."""

    def test_update_plain_column(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={"rows": [{"display_name": "Alice", "age": 30}]},
        )
        resp = client.post(
            "/v1/db/users/update",
            json={
                "values": {"display_name": "Alice Updated"},
                "filters": [
                    {"column": "display_name", "op": "eq", "value": "Alice"}
                ],
            },
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["display_name"] == "Alice Updated"

    def test_update_via_blind_index(self, client: TestClient) -> None:
        """Update matched by searchable column filter (routes to _index)."""
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {
                        "display_name": "Alice",
                        "email": "old_cipher",
                        "email_index": "hmac_alice",
                        "age": 30,
                    }
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/update",
            json={
                "values": {"display_name": "Alice V2"},
                "filters": [
                    {"column": "email", "op": "eq", "value": "hmac_alice"}
                ],
            },
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["display_name"] == "Alice V2"

    def test_update_no_match_returns_empty_data(
        self, client: TestClient
    ) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/update",
            json={
                "values": {"display_name": "Nobody"},
                "filters": [
                    {
                        "column": "display_name",
                        "op": "eq",
                        "value": "nonexistent",
                    }
                ],
            },
        )
        assert resp.status_code == 200
        assert resp.json()["data"] == []

    def test_update_unknown_column_returns_400(
        self, client: TestClient
    ) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/update",
            json={
                "values": {"fake_col": "value"},
                "filters": [
                    {"column": "display_name", "op": "eq", "value": "Alice"}
                ],
            },
        )
        assert resp.status_code == 400

    def test_update_empty_values_returns_400(
        self, client: TestClient
    ) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/update",
            json={
                "values": {},
                "filters": [
                    {"column": "display_name", "op": "eq", "value": "Alice"}
                ],
            },
        )
        assert resp.status_code == 400


# --- Delete ---


class TestDelete:
    """Test POST /{table}/delete."""

    def test_delete_by_plain_column(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {"display_name": "Alice", "age": 30},
                    {"display_name": "Bob", "age": 25},
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/delete",
            json={
                "filters": [
                    {"column": "display_name", "op": "eq", "value": "Alice"}
                ]
            },
        )
        assert resp.status_code == 200
        deleted = resp.json()["data"]
        assert len(deleted) == 1
        assert deleted[0]["display_name"] == "Alice"

        # Verify Alice is gone
        select_resp = client.post("/v1/db/users/select", json={})
        remaining = select_resp.json()["data"]
        assert len(remaining) == 1
        assert remaining[0]["display_name"] == "Bob"

    def test_delete_by_blind_index(self, client: TestClient) -> None:
        _create_table(client)
        client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {
                        "display_name": "Alice",
                        "email": "c1",
                        "email_index": "hmac_a",
                        "age": 30,
                    },
                    {
                        "display_name": "Bob",
                        "email": "c2",
                        "email_index": "hmac_b",
                        "age": 25,
                    },
                ]
            },
        )
        resp = client.post(
            "/v1/db/users/delete",
            json={
                "filters": [
                    {"column": "email", "op": "eq", "value": "hmac_a"}
                ]
            },
        )
        assert resp.status_code == 200
        assert len(resp.json()["data"]) == 1

    def test_delete_without_filters_returns_400(
        self, client: TestClient
    ) -> None:
        _create_table(client)
        resp = client.post(
            "/v1/db/users/delete",
            json={"filters": []},
        )
        assert resp.status_code == 400


# --- Full round-trip ---


class TestFullRoundTrip:
    """Insert -> Select -> Update -> Delete with blind index."""

    def test_crud_round_trip(self, client: TestClient) -> None:
        _create_table(client)

        # 1. Insert with searchable and private columns
        insert_resp = client.post(
            "/v1/db/users/insert",
            json={
                "rows": [
                    {
                        "display_name": "Alice",
                        "email": "cipher_alice",
                        "email_index": "hmac_alice",
                        "ssn": "ssn_cipher",
                        "age": 30,
                    }
                ]
            },
        )
        assert insert_resp.status_code == 201
        inserted_id = insert_resp.json()["data"][0]["id"]

        # 2. Select by searchable column (routes to blind index)
        select_resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [
                    {"column": "email", "op": "eq", "value": "hmac_alice"}
                ]
            },
        )
        assert select_resp.status_code == 200
        found = select_resp.json()["data"]
        assert len(found) == 1
        assert found[0]["id"] == inserted_id
        assert found[0]["email_encrypted"] == "cipher_alice"

        # 3. Update plain column via searchable filter
        update_resp = client.post(
            "/v1/db/users/update",
            json={
                "values": {"display_name": "Alice V2"},
                "filters": [
                    {"column": "email", "op": "eq", "value": "hmac_alice"}
                ],
            },
        )
        assert update_resp.status_code == 200
        updated = update_resp.json()["data"]
        assert updated[0]["display_name"] == "Alice V2"

        # 4. Verify update via select
        verify_resp = client.post(
            "/v1/db/users/select",
            json={
                "filters": [
                    {"column": "email", "op": "eq", "value": "hmac_alice"}
                ]
            },
        )
        assert verify_resp.json()["data"][0]["display_name"] == "Alice V2"

        # 5. Delete via searchable column
        delete_resp = client.post(
            "/v1/db/users/delete",
            json={
                "filters": [
                    {"column": "email", "op": "eq", "value": "hmac_alice"}
                ]
            },
        )
        assert delete_resp.status_code == 200
        assert len(delete_resp.json()["data"]) == 1

        # 6. Verify deletion
        final_resp = client.post("/v1/db/users/select", json={})
        assert final_resp.json()["data"] == []


class TestHealthUnaffected:
    """Platform health check still works with CRUD routes included."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
