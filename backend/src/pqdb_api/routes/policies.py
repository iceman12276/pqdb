"""Table-level RLS policy endpoints (US-040).

POST   /v1/db/tables/{name}/policies        — create policy (developer JWT)
GET    /v1/db/tables/{name}/policies         — list policies (apikey)
DELETE /v1/db/tables/{name}/policies/{id}    — delete policy (developer JWT)

Policy creation/deletion requires a developer JWT (via Bearer token).
Listing policies requires an apikey header (project-scoped).
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import (
    ProjectContext,
    get_project_context,
    get_project_session,
)
from pqdb_api.services.auth_engine import ensure_auth_tables
from pqdb_api.services.roles_policies import (
    PolicyCondition,
    PolicyOperation,
    create_policy,
    delete_policy,
    get_policies_for_table,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/v1/db/tables", tags=["policies"])


class CreatePolicyRequest(BaseModel):
    """Request body for creating an RLS policy."""

    name: str
    operation: str
    role: str
    condition: str

    @field_validator("operation")
    @classmethod
    def validate_operation(cls, v: str) -> str:
        valid = {"select", "insert", "update", "delete"}
        if v not in valid:
            raise ValueError(f"operation must be one of {sorted(valid)}")
        return v

    @field_validator("condition")
    @classmethod
    def validate_condition(cls, v: str) -> str:
        valid = {"owner", "all", "none"}
        if v not in valid:
            raise ValueError(f"condition must be one of {sorted(valid)}")
        return v


def _require_developer_jwt(request: Request) -> None:
    """Check that the request has a Bearer token (developer JWT).

    Policy creation/deletion requires developer JWT. We check for
    the Authorization header here; actual JWT validation happens
    in the middleware.
    """
    auth_header = request.headers.get("authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Developer JWT required for this operation",
        )


@router.post(
    "/{table_name}/policies",
    status_code=201,
)
async def create_policy_endpoint(
    table_name: str,
    body: CreatePolicyRequest,
    request: Request,
    session: AsyncSession = Depends(get_project_session),
    context: ProjectContext = Depends(get_project_context),
) -> dict[str, Any]:
    """Create an RLS policy for a table.

    Requires developer JWT (passed as Bearer token alongside apikey header).
    """
    _require_developer_jwt(request)

    await ensure_auth_tables(session)
    try:
        policy = await create_policy(
            session,
            table_name=table_name,
            name=body.name,
            operation=PolicyOperation(body.operation),
            role=body.role,
            condition=PolicyCondition(body.condition),
        )
        return policy
    except ValueError as exc:
        msg = str(exc)
        if "already exists" in msg:
            raise HTTPException(status_code=409, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc


@router.get("/{table_name}/policies")
async def list_policies_endpoint(
    table_name: str,
    session: AsyncSession = Depends(get_project_session),
    context: ProjectContext = Depends(get_project_context),
) -> list[dict[str, Any]]:
    """List all policies for a table. Requires apikey header."""
    await ensure_auth_tables(session)
    return await get_policies_for_table(session, table_name)


@router.delete(
    "/{table_name}/policies/{policy_id}",
    status_code=204,
)
async def delete_policy_endpoint(
    table_name: str,
    policy_id: str,
    request: Request,
    session: AsyncSession = Depends(get_project_session),
    context: ProjectContext = Depends(get_project_context),
) -> None:
    """Delete a specific RLS policy. Requires developer JWT."""
    _require_developer_jwt(request)

    await ensure_auth_tables(session)
    try:
        await delete_policy(session, policy_id)
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
