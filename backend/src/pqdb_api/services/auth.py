"""Authentication service: JWT tokens and password hashing."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
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
JWT_ALGORITHM = "EdDSA"


def generate_ed25519_keypair() -> tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    """Generate a new Ed25519 key pair for JWT signing."""
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    return private_key, public_key


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


def create_access_token(
    developer_id: uuid.UUID,
    private_key: Ed25519PrivateKey,
) -> str:
    """Create a short-lived JWT access token."""
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(developer_id),
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)


def create_refresh_token(
    developer_id: uuid.UUID,
    private_key: Ed25519PrivateKey,
) -> str:
    """Create a long-lived JWT refresh token."""
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(developer_id),
        "type": "refresh",
        "iat": now,
        "exp": now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(payload, private_key, algorithm=JWT_ALGORITHM)


def decode_token(
    token: str,
    public_key: Ed25519PublicKey,
) -> dict[str, Any]:
    """Decode and validate a JWT token. Raises jwt.PyJWTError on failure."""
    payload: dict[str, Any] = jwt.decode(token, public_key, algorithms=[JWT_ALGORITHM])
    return payload
