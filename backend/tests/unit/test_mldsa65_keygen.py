"""Unit tests for ML-DSA-65 keypair generation."""

import pytest

try:
    import oqs

    HAS_OQS = True
except (ImportError, SystemExit, RuntimeError):
    oqs = None
    HAS_OQS = False

from pqdb_api.services.auth import generate_mldsa65_keypair

MLDSA65_ALGORITHM = "ML-DSA-65"

pytestmark = pytest.mark.skipif(
    not HAS_OQS, reason="liboqs native library not available"
)


class TestMLDSA65KeypairGeneration:
    """Tests for ML-DSA-65 key generation and signature round-trip."""

    def test_returns_tuple_of_bytes(self) -> None:
        private_key, public_key = generate_mldsa65_keypair()
        assert isinstance(private_key, bytes)
        assert isinstance(public_key, bytes)

    def test_private_key_is_nonempty(self) -> None:
        private_key, _ = generate_mldsa65_keypair()
        assert len(private_key) > 0

    def test_public_key_is_nonempty(self) -> None:
        _, public_key = generate_mldsa65_keypair()
        assert len(public_key) > 0

    def test_keypairs_are_unique(self) -> None:
        pk1, pub1 = generate_mldsa65_keypair()
        pk2, pub2 = generate_mldsa65_keypair()
        assert pk1 != pk2
        assert pub1 != pub2

    def test_sign_verify_roundtrip(self) -> None:
        """Verify that a signature produced with the private key
        can be verified with the corresponding public key."""
        private_key, public_key = generate_mldsa65_keypair()
        message = b"post-quantum cryptography is the future"

        # Sign with private key
        signer = oqs.Signature(MLDSA65_ALGORITHM, private_key)
        signature = signer.sign(message)

        # Verify with public key
        verifier = oqs.Signature(MLDSA65_ALGORITHM)
        is_valid = verifier.verify(message, signature, public_key)
        assert is_valid is True

    def test_verify_fails_with_wrong_key(self) -> None:
        """Verify that a signature does not verify with a different public key."""
        private_key, _ = generate_mldsa65_keypair()
        _, other_public_key = generate_mldsa65_keypair()
        message = b"this should not verify"

        signer = oqs.Signature(MLDSA65_ALGORITHM, private_key)
        signature = signer.sign(message)

        verifier = oqs.Signature(MLDSA65_ALGORITHM)
        is_valid = verifier.verify(message, signature, other_public_key)
        assert is_valid is False

    def test_verify_fails_with_tampered_message(self) -> None:
        """Verify that a signature does not verify with a different message."""
        private_key, public_key = generate_mldsa65_keypair()
        message = b"original message"

        signer = oqs.Signature(MLDSA65_ALGORITHM, private_key)
        signature = signer.sign(message)

        verifier = oqs.Signature(MLDSA65_ALGORITHM)
        is_valid = verifier.verify(b"tampered message", signature, public_key)
        assert is_valid is False
