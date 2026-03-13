"""CLI entrypoint for uvicorn."""

import uvicorn


def main() -> None:
    """Run the pqdb API server via uvicorn."""
    uvicorn.run(
        "pqdb_api.app:create_app",
        factory=True,
        host="0.0.0.0",  # noqa: S104
        port=8000,
        reload=True,
    )
