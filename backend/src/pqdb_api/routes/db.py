"""Project-scoped database endpoints.

All routes under ``/v1/db`` require a valid ``apikey`` header.
The API key middleware resolves the project and injects a project-scoped
database session.
"""

from fastapi import APIRouter, Depends

from pqdb_api.middleware.api_key import ProjectContext, get_project_context

router = APIRouter(prefix="/v1/db", tags=["db"])


@router.get("/health")
async def db_health(
    context: ProjectContext = Depends(get_project_context),
) -> dict[str, object]:
    """Project database health — confirms API key resolves to a valid project."""
    return {
        "status": "ok",
        "project_id": str(context.project_id),
        "role": context.key_role,
    }
