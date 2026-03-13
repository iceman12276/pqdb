"""Smoke tests for pqdb_api package."""

from pqdb_api import __version__


def test_version() -> None:
    assert __version__ == "0.1.0"


def test_package_importable() -> None:
    import pqdb_api

    assert hasattr(pqdb_api, "__version__")
