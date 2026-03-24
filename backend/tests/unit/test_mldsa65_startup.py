"""Test that ML-DSA-65 keypair is generated on app startup."""

from unittest.mock import patch

import pytest

try:
    import oqs

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    oqs = None
    HAS_OQS = False

from pqdb_api.app import create_app
from pqdb_api.config import Settings
from pqdb_api.services.auth import MLDSA65_ALGORITHM

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)


def test_mldsa65_keys_stored_in_app_state() -> None:
    """Verify that app startup generates and stores ML-DSA-65 keys."""
    settings = Settings()
    app = create_app(settings)

    with (
        patch("pqdb_api.app.init_engine"),
        patch("pqdb_api.app.dispose_engine"),
        patch("pqdb_api.app.DatabaseProvisioner"),
        patch("pqdb_api.app.VaultClient"),
    ):
        from starlette.testclient import TestClient

        with TestClient(app) as client:
            resp = client.get("/health")
            assert resp.status_code == 200

            assert hasattr(app.state, "mldsa65_private_key")
            assert hasattr(app.state, "mldsa65_public_key")
            assert isinstance(app.state.mldsa65_private_key, bytes)
            assert isinstance(app.state.mldsa65_public_key, bytes)
            assert len(app.state.mldsa65_private_key) > 0
            assert len(app.state.mldsa65_public_key) > 0


def test_mldsa65_startup_keys_are_valid() -> None:
    """Verify that startup-generated ML-DSA-65 keys produce valid signatures."""
    settings = Settings()
    app = create_app(settings)

    with (
        patch("pqdb_api.app.init_engine"),
        patch("pqdb_api.app.dispose_engine"),
        patch("pqdb_api.app.DatabaseProvisioner"),
        patch("pqdb_api.app.VaultClient"),
    ):
        from starlette.testclient import TestClient

        with TestClient(app) as client:
            client.get("/health")

            message = b"startup test"
            signer = oqs.Signature(MLDSA65_ALGORITHM, app.state.mldsa65_private_key)
            signature = signer.sign(message)

            verifier = oqs.Signature(MLDSA65_ALGORITHM)
            assert verifier.verify(message, signature, app.state.mldsa65_public_key)


def test_no_ed25519_keys_after_startup() -> None:
    """Verify Ed25519 keys are no longer generated (clean ML-DSA-65 cutover)."""
    settings = Settings()
    app = create_app(settings)

    with (
        patch("pqdb_api.app.init_engine"),
        patch("pqdb_api.app.dispose_engine"),
        patch("pqdb_api.app.DatabaseProvisioner"),
        patch("pqdb_api.app.VaultClient"),
    ):
        from starlette.testclient import TestClient

        with TestClient(app) as client:
            client.get("/health")

            assert not hasattr(app.state, "jwt_private_key")
            assert not hasattr(app.state, "jwt_public_key")
