"""Integration smoke test placeholder.

Actual integration tests will boot the FastAPI app (US-004+).
For now, verify the package structure is importable.
"""


def test_package_structure() -> None:
    from pqdb_api import __version__

    assert isinstance(__version__, str)
