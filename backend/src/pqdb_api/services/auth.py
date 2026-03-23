"""Authentication service: ML-DSA-65 JWT tokens and password hashing."""

import base64
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

_hasher = PasswordHasher()

ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7
JWT_ALGORITHM = "EdDSA"  # kept for backward compat references only

MLDSA65_ALGORITHM = "ML-DSA-65"


class InvalidTokenError(Exception):
    """Raised when a token is malformed or has an invalid signature."""


class TokenExpiredError(InvalidTokenError):
    """Raised when a token's exp claim is in the past."""


def generate_ed25519_keypair() -> tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    """Generate a new Ed25519 key pair for JWT signing."""
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    return private_key, public_key


def generate_mldsa65_keypair() -> tuple[bytes, bytes]:
    """Generate a new ML-DSA-65 key pair for post-quantum JWT signing.

    Returns (private_key, public_key) as raw bytes.
    """
    import oqs  # lazy import: liboqs requires cmake at first build

    signer = oqs.Signature(MLDSA65_ALGORITHM)
    public_key = signer.generate_keypair()
    private_key = signer.export_secret_key()
    return bytes(private_key), bytes(public_key)


def private_key_to_pem(key: Ed25519PrivateKey) -> bytes:
    """Serialize Ed25519 private key to PEM bytes."""
    return key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())


def public_key_to_pem(key: Ed25519PublicKey) -> bytes:
    """Serialize Ed25519 public key to PEM bytes."""
    return key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)


def hash_password(password: str) -> str:
    """Hash a password using argon2id."""
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """Verify a password against an argon2id hash. Returns False on mismatch."""
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def _b64url_encode(data: bytes) -> str:
    """Base64url encode without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """Base64url decode with padding restoration."""
    padded = s + "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(padded)


def _build_mldsa65_token(payload_dict: dict[str, Any], private_key: bytes) -> str:
    """Build a custom JWT-like token signed with ML-DSA-65.

    Format: base64url(header) + "." + base64url(payload) + "." + base64url(signature)
    """
    import oqs  # lazy import

    header = {"alg": MLDSA65_ALGORITHM, "typ": "JWT"}
    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = _b64url_encode(
        json.dumps(payload_dict, separators=(",", ":")).encode()
    )

    message = f"{header_b64}.{payload_b64}".encode("ascii")
    signer = oqs.Signature(MLDSA65_ALGORITHM, private_key)
    signature = signer.sign(message)

    sig_b64 = _b64url_encode(signature)
    return f"{header_b64}.{payload_b64}.{sig_b64}"


def create_access_token(
    developer_id: uuid.UUID,
    private_key: bytes,
) -> str:
    """Create a short-lived ML-DSA-65 access token."""
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(developer_id),
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)).timestamp()),
    }
    return _build_mldsa65_token(payload, private_key)


def create_refresh_token(
    developer_id: uuid.UUID,
    private_key: bytes,
) -> str:
    """Create a long-lived ML-DSA-65 refresh token."""
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(developer_id),
        "type": "refresh",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)).timestamp()),
    }
    return _build_mldsa65_token(payload, private_key)


def decode_token(
    token: str,
    public_key: bytes,
) -> dict[str, Any]:
    """Decode and validate an ML-DSA-65 token.

    Raises InvalidTokenError for malformed/tampered tokens.
    Raises TokenExpiredError for expired tokens.
    """
    import oqs  # lazy import

    # Split token into parts
    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidTokenError("Token must have exactly 3 dot-separated parts")

    header_b64, payload_b64, sig_b64 = parts

    # Decode and validate header
    try:
        header = json.loads(_b64url_decode(header_b64))
    except (json.JSONDecodeError, Exception) as exc:
        raise InvalidTokenError(f"Invalid token header: {exc}") from exc

    if header.get("alg") != MLDSA65_ALGORITHM:
        raise InvalidTokenError(
            f"Algorithm mismatch: expected {MLDSA65_ALGORITHM}, "
            f"got {header.get('alg')}"
        )

    # Verify ML-DSA-65 signature
    try:
        signature = _b64url_decode(sig_b64)
    except Exception as exc:
        raise InvalidTokenError(f"Invalid signature encoding: {exc}") from exc

    message = f"{header_b64}.{payload_b64}".encode("ascii")
    verifier = oqs.Signature(MLDSA65_ALGORITHM)
    is_valid = verifier.verify(message, signature, public_key)
    if not is_valid:
        raise InvalidTokenError("Signature verification failed")

    # Decode payload
    try:
        payload: dict[str, Any] = json.loads(_b64url_decode(payload_b64))
    except (json.JSONDecodeError, Exception) as exc:
        raise InvalidTokenError(f"Invalid token payload: {exc}") from exc

    # Validate expiration
    exp = payload.get("exp")
    if exp is None:
        raise InvalidTokenError("Token missing exp claim")
    if time.time() > exp:
        raise TokenExpiredError("Token has expired")

    return payload
