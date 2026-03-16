"""Unit tests for custom roles + RLS policies (US-040).

Tests:
- _pqdb_roles and _pqdb_policies table creation via ensure_auth_tables()
- Built-in roles seeded (authenticated, anon)
- Role CRUD helpers
- Policy CRUD helpers
- Policy-based RLS enforcement in inject_rls_filters()
- Fallback to basic owner-column RLS when no policies exist
- Service role bypass
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.services.auth_engine import (
    ensure_auth_tables,
)
from pqdb_api.services.crud import (
    CrudError,
    FilterOp,
    inject_rls_filters,
)
from pqdb_api.services.roles_policies import (
    PolicyCondition,
    PolicyOperation,
    create_policy,
    create_role,
    delete_policy,
    delete_role,
    get_policies_for_table,
    list_roles,
    lookup_policy,
)


@pytest.fixture()
def engine():  # type: ignore[no-untyped-def]
    """Create an in-memory SQLite engine."""
    return create_async_engine("sqlite+aiosqlite://", echo=False)


@pytest.fixture()
def session_factory(engine):  # type: ignore[no-untyped-def]
    """Create a session factory."""
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class TestEnsureAuthTablesCreatesRolesAndPolicies:
    """ensure_auth_tables() now also creates _pqdb_roles and _pqdb_policies."""

    @pytest.mark.asyncio()
    async def test_creates_roles_table(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(
                text(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name='_pqdb_roles'"
                )
            )
            assert result.scalar() == "_pqdb_roles"

    @pytest.mark.asyncio()
    async def test_creates_policies_table(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(
                text(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name='_pqdb_policies'"
                )
            )
            assert result.scalar() == "_pqdb_policies"

    @pytest.mark.asyncio()
    async def test_seeds_built_in_roles(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(
                text("SELECT name FROM _pqdb_roles ORDER BY name")
            )
            names = [row[0] for row in result.fetchall()]
            assert "anon" in names
            assert "authenticated" in names

    @pytest.mark.asyncio()
    async def test_seeding_is_idempotent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await ensure_auth_tables(session)
            result = await session.execute(
                text("SELECT count(*) FROM _pqdb_roles WHERE name = 'authenticated'")
            )
            assert result.scalar() == 1

    @pytest.mark.asyncio()
    async def test_roles_table_columns(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(text("PRAGMA table_info(_pqdb_roles)"))
            columns = {row[1] for row in result.fetchall()}
            expected = {"id", "name", "description", "created_at"}
            assert expected.issubset(columns)

    @pytest.mark.asyncio()
    async def test_policies_table_columns(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            result = await session.execute(text("PRAGMA table_info(_pqdb_policies)"))
            columns = {row[1] for row in result.fetchall()}
            expected = {
                "id",
                "table_name",
                "name",
                "operation",
                "role",
                "condition",
                "created_at",
            }
            assert expected.issubset(columns)


class TestCreateRole:
    """create_role() inserts a new custom role."""

    @pytest.mark.asyncio()
    async def test_create_custom_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            role = await create_role(session, "moderator", "Can moderate content")
            assert role["name"] == "moderator"
            assert role["description"] == "Can moderate content"
            assert "id" in role

    @pytest.mark.asyncio()
    async def test_create_duplicate_role_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await create_role(session, "moderator", "First")
            with pytest.raises(ValueError, match="already exists"):
                await create_role(session, "moderator", "Second")

    @pytest.mark.asyncio()
    async def test_cannot_create_reserved_role_anon(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="reserved"):
                await create_role(session, "anon", "Try to overwrite")

    @pytest.mark.asyncio()
    async def test_cannot_create_reserved_role_authenticated(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="reserved"):
                await create_role(session, "authenticated", "Try to overwrite")


class TestListRoles:
    """list_roles() returns built-in + custom roles."""

    @pytest.mark.asyncio()
    async def test_list_built_in_roles(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            roles = await list_roles(session)
            names = {r["name"] for r in roles}
            assert "anon" in names
            assert "authenticated" in names

    @pytest.mark.asyncio()
    async def test_list_includes_custom_roles(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await create_role(session, "admin", "Admin role")
            roles = await list_roles(session)
            names = {r["name"] for r in roles}
            assert "admin" in names
            assert "authenticated" in names


class TestDeleteRole:
    """delete_role() removes custom role and its policies."""

    @pytest.mark.asyncio()
    async def test_delete_custom_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await create_role(session, "moderator", "Mod")
            await delete_role(session, "moderator")
            roles = await list_roles(session)
            names = {r["name"] for r in roles}
            assert "moderator" not in names

    @pytest.mark.asyncio()
    async def test_delete_built_in_role_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="Cannot delete built-in"):
                await delete_role(session, "authenticated")

    @pytest.mark.asyncio()
    async def test_delete_built_in_role_anon_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="Cannot delete built-in"):
                await delete_role(session, "anon")

    @pytest.mark.asyncio()
    async def test_delete_nonexistent_role_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="not found"):
                await delete_role(session, "nonexistent")

    @pytest.mark.asyncio()
    async def test_delete_role_cascades_policies(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await create_role(session, "moderator", "Mod")
            await create_policy(
                session,
                table_name="posts",
                name="mod_select",
                operation=PolicyOperation.SELECT,
                role="moderator",
                condition=PolicyCondition.ALL,
            )
            await delete_role(session, "moderator")
            policies = await get_policies_for_table(session, "posts")
            assert len(policies) == 0


class TestCreatePolicy:
    """create_policy() inserts an RLS policy."""

    @pytest.mark.asyncio()
    async def test_create_policy(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            policy = await create_policy(
                session,
                table_name="posts",
                name="auth_select_all",
                operation=PolicyOperation.SELECT,
                role="authenticated",
                condition=PolicyCondition.ALL,
            )
            assert policy["table_name"] == "posts"
            assert policy["operation"] == "select"
            assert policy["role"] == "authenticated"
            assert policy["condition"] == "all"

    @pytest.mark.asyncio()
    async def test_duplicate_policy_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await create_policy(
                session,
                table_name="posts",
                name="auth_select",
                operation=PolicyOperation.SELECT,
                role="authenticated",
                condition=PolicyCondition.ALL,
            )
            with pytest.raises(ValueError, match="already exists"):
                await create_policy(
                    session,
                    table_name="posts",
                    name="auth_select_dup",
                    operation=PolicyOperation.SELECT,
                    role="authenticated",
                    condition=PolicyCondition.OWNER,
                )

    @pytest.mark.asyncio()
    async def test_create_policy_for_nonexistent_role_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="Role .* does not exist"):
                await create_policy(
                    session,
                    table_name="posts",
                    name="ghost_select",
                    operation=PolicyOperation.SELECT,
                    role="ghost_role",
                    condition=PolicyCondition.ALL,
                )


class TestGetPoliciesForTable:
    """get_policies_for_table() returns policies for a table."""

    @pytest.mark.asyncio()
    async def test_returns_policies(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await create_policy(
                session,
                table_name="posts",
                name="auth_select",
                operation=PolicyOperation.SELECT,
                role="authenticated",
                condition=PolicyCondition.ALL,
            )
            await create_policy(
                session,
                table_name="posts",
                name="anon_select",
                operation=PolicyOperation.SELECT,
                role="anon",
                condition=PolicyCondition.NONE,
            )
            policies = await get_policies_for_table(session, "posts")
            assert len(policies) == 2

    @pytest.mark.asyncio()
    async def test_returns_empty_for_no_policies(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            policies = await get_policies_for_table(session, "no_such_table")
            assert policies == []


class TestDeletePolicy:
    """delete_policy() removes a specific policy."""

    @pytest.mark.asyncio()
    async def test_delete_policy(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            policy = await create_policy(
                session,
                table_name="posts",
                name="auth_select",
                operation=PolicyOperation.SELECT,
                role="authenticated",
                condition=PolicyCondition.ALL,
            )
            await delete_policy(session, policy["id"])
            policies = await get_policies_for_table(session, "posts")
            assert len(policies) == 0

    @pytest.mark.asyncio()
    async def test_delete_nonexistent_policy_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            with pytest.raises(ValueError, match="not found"):
                await delete_policy(session, str(uuid.uuid4()))


class TestLookupPolicy:
    """lookup_policy() finds a specific policy by (table, operation, role)."""

    @pytest.mark.asyncio()
    async def test_finds_matching_policy(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            await create_policy(
                session,
                table_name="posts",
                name="auth_select",
                operation=PolicyOperation.SELECT,
                role="authenticated",
                condition=PolicyCondition.ALL,
            )
            policy = await lookup_policy(session, "posts", "select", "authenticated")
            assert policy is not None
            assert policy["condition"] == "all"

    @pytest.mark.asyncio()
    async def test_returns_none_when_no_match(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await ensure_auth_tables(session)
            policy = await lookup_policy(session, "posts", "select", "authenticated")
            assert policy is None


class TestInjectRlsFiltersWithPolicies:
    """inject_rls_filters uses policy lookup when policies exist."""

    COLUMNS_WITH_OWNER = [
        {
            "name": "title",
            "sensitivity": "plain",
            "data_type": "text",
            "is_owner": False,
        },
        {
            "name": "user_id",
            "sensitivity": "plain",
            "data_type": "uuid",
            "is_owner": True,
        },
    ]

    COLUMNS_WITHOUT_OWNER = [
        {
            "name": "title",
            "sensitivity": "plain",
            "data_type": "text",
            "is_owner": False,
        },
    ]

    def test_service_role_always_bypasses(self) -> None:
        """Service role bypasses RLS regardless of policies."""
        result = inject_rls_filters(
            filters=[],
            columns_meta=self.COLUMNS_WITH_OWNER,
            key_role="service",
            user_id=uuid.uuid4(),
            policies=[{"condition": "none"}],
        )
        assert result == []

    def test_policy_condition_all_no_filter(self) -> None:
        """'all' condition allows unrestricted access."""
        user_id = uuid.uuid4()
        result = inject_rls_filters(
            filters=[],
            columns_meta=self.COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
            policies=[{"condition": "all"}],
        )
        assert result == []

    def test_policy_condition_none_raises(self) -> None:
        """'none' condition denies access."""
        user_id = uuid.uuid4()
        with pytest.raises(CrudError, match="denied by policy"):
            inject_rls_filters(
                filters=[],
                columns_meta=self.COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=user_id,
                policies=[{"condition": "none"}],
            )

    def test_policy_condition_owner_injects_filter(self) -> None:
        """'owner' condition injects WHERE owner_col = user_id."""
        user_id = uuid.uuid4()
        result = inject_rls_filters(
            filters=[],
            columns_meta=self.COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
            policies=[{"condition": "owner"}],
        )
        assert len(result) == 1
        col, op, val = result[0]
        assert col == "user_id"
        assert op == FilterOp.EQ
        assert val == str(user_id)

    def test_policy_owner_no_user_raises(self) -> None:
        """'owner' condition without user context raises."""
        with pytest.raises(CrudError, match="User context required"):
            inject_rls_filters(
                filters=[],
                columns_meta=self.COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=None,
                policies=[{"condition": "owner"}],
            )

    def test_no_policy_found_raises(self) -> None:
        """No matching policy => deny with 403 (empty policies list means policies
        exist for the table but not for this role/operation)."""
        user_id = uuid.uuid4()
        with pytest.raises(CrudError, match="denied by policy"):
            inject_rls_filters(
                filters=[],
                columns_meta=self.COLUMNS_WITH_OWNER,
                key_role="anon",
                user_id=user_id,
                policies=[],
            )

    def test_no_policies_none_falls_back_to_basic_rls(self) -> None:
        """When policies is None (no policies for table), fall back to basic RLS."""
        user_id = uuid.uuid4()
        result = inject_rls_filters(
            filters=[],
            columns_meta=self.COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
            policies=None,
        )
        # Basic RLS: injects owner column filter
        assert len(result) == 1
        assert result[0][0] == "user_id"

    def test_no_policies_no_owner_no_filter(self) -> None:
        """No policies, no owner column => no RLS."""
        user_id = uuid.uuid4()
        result = inject_rls_filters(
            filters=[],
            columns_meta=self.COLUMNS_WITHOUT_OWNER,
            key_role="anon",
            user_id=user_id,
            policies=None,
        )
        assert result == []

    def test_preserves_existing_filters(self) -> None:
        """Policy-based RLS preserves existing user filters."""
        user_id = uuid.uuid4()
        existing = [("title", FilterOp.EQ, "hello")]
        result = inject_rls_filters(
            filters=existing,
            columns_meta=self.COLUMNS_WITH_OWNER,
            key_role="anon",
            user_id=user_id,
            policies=[{"condition": "owner"}],
        )
        assert len(result) == 2
        assert result[0] == ("title", FilterOp.EQ, "hello")
        assert result[1][0] == "user_id"
