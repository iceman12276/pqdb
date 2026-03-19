"""Passkey/WebAuthn endpoints — US-053.

GET  /v1/auth/passkeys/challenge      — registration or authentication options
POST /v1/auth/passkeys/register        — validate attestation, store credential
POST /v1/auth/passkeys/authenticate    — validate assertion, issue developer JWT
GET  /v1/auth/passkeys                 — list passkeys for the current developer
DELETE /v1/auth/passkeys/{credential_id} — delete a passkey
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import structlog
import webauthn
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from pqdb_api.database import get_session
from pqdb_api.middleware.auth import get_current_developer_id
from pqdb_api.models.developer import Developer, DeveloperCredential
from pqdb_api.services.auth import create_access_token, create_refresh_token

logger = structlog.get_logger()

router = APIRouter(
    prefix="/v1/auth/passkeys",
    tags=["passkeys"],
)

# In-memory challenge store: maps challenge bytes -> (developer_id | None, purpose)
# In production this would use Redis or a database table with TTL.
_challenge_store: dict[str, dict[str, Any]] = {}


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded)


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    credential: dict[str, Any]
    name: str | None = None


class AuthenticateRequest(BaseModel):
    credential: dict[str, Any]


class PasskeyResponse(BaseModel):
    id: str
    name: str | None
    created_at: str
    last_used_at: str | None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


# ---------------------------------------------------------------------------
# Challenge endpoint
# ---------------------------------------------------------------------------
@router.get("/challenge")
async def get_challenge(
    request: Request,
    purpose: str = "authentication",
    developer_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Generate WebAuthn registration or authentication options.

    For registration: requires Authorization header (authenticated developer).
    For authentication: no auth required (discoverable credentials).

    Query params:
        purpose: "registration" or "authentication" (default: "authentication")
    """
    settings = request.app.state.settings
    rp_id = settings.webauthn_rp_id
    rp_name = settings.webauthn_rp_name
    origin = settings.webauthn_origin

    if purpose == "registration":
        # Need authenticated developer for registration
        if developer_id is None:
            raise HTTPException(
                status_code=400,
                detail="Registration requires authentication",
            )

        # Get developer email
        result = await session.execute(
            select(Developer).where(Developer.id == developer_id)
        )
        developer = result.scalar_one_or_none()
        if developer is None:
            raise HTTPException(status_code=404, detail="Developer not found")

        # Get existing credentials for exclusion
        creds_result = await session.execute(
            select(DeveloperCredential).where(
                DeveloperCredential.developer_id == developer_id
            )
        )
        existing_creds = creds_result.scalars().all()
        exclude_credentials = [
            PublicKeyCredentialDescriptor(id=c.credential_id) for c in existing_creds
        ]

        reg_options = webauthn.generate_registration_options(
            rp_id=rp_id,
            rp_name=rp_name,
            user_name=developer.email,
            user_id=developer.id.bytes,
            user_display_name=developer.email,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.REQUIRED,
                user_verification=UserVerificationRequirement.PREFERRED,
            ),
            exclude_credentials=exclude_credentials,
        )

        reg_json = webauthn.options_to_json(reg_options)

        # Store challenge for verification
        _challenge_store[_b64url_encode(reg_options.challenge)] = {
            "developer_id": str(developer_id),
            "purpose": "registration",
            "origin": origin,
            "rp_id": rp_id,
        }

        result_dict: dict[str, Any] = json.loads(reg_json)
        return result_dict

    else:
        # Authentication — discoverable credentials (empty allowCredentials)
        auth_options = webauthn.generate_authentication_options(
            rp_id=rp_id,
            allow_credentials=[],
            user_verification=UserVerificationRequirement.PREFERRED,
        )

        auth_json = webauthn.options_to_json(auth_options)

        _challenge_store[_b64url_encode(auth_options.challenge)] = {
            "developer_id": None,
            "purpose": "authentication",
            "origin": origin,
            "rp_id": rp_id,
        }

        auth_result: dict[str, Any] = json.loads(auth_json)
        return auth_result


# ---------------------------------------------------------------------------
# Registration endpoint
# ---------------------------------------------------------------------------
@router.post("/register")
async def register_passkey(
    body: RegisterRequest,
    request: Request,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> PasskeyResponse:
    """Validate attestation and store new passkey credential."""
    settings = request.app.state.settings
    rp_id = settings.webauthn_rp_id
    origin = settings.webauthn_origin

    # Extract challenge from the credential response
    resp_data = body.credential.get("response", {})
    client_data_json_b64: str = resp_data.get("clientDataJSON", "")
    try:
        client_data_bytes = _b64url_decode(client_data_json_b64)
        client_data = json.loads(client_data_bytes)
        challenge_b64: str = client_data.get("challenge", "")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid credential data")

    stored = _challenge_store.pop(challenge_b64, None)
    if stored is None:
        raise HTTPException(status_code=400, detail="Challenge not found or expired")

    if stored["developer_id"] != str(developer_id):
        raise HTTPException(status_code=400, detail="Challenge mismatch")

    try:
        verification = webauthn.verify_registration_response(
            credential=body.credential,
            expected_challenge=_b64url_decode(challenge_b64),
            expected_rp_id=rp_id,
            expected_origin=origin,
        )
    except Exception as exc:
        logger.error("passkey_registration_failed", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail=f"Registration verification failed: {exc}",
        )

    # Store credential
    cred = DeveloperCredential(
        id=uuid.uuid4(),
        developer_id=developer_id,
        credential_id=verification.credential_id,
        public_key=verification.credential_public_key,
        sign_count=verification.sign_count,
        name=body.name,
    )
    session.add(cred)
    await session.commit()
    await session.refresh(cred)

    logger.info(
        "passkey_registered",
        developer_id=str(developer_id),
        credential_id=_b64url_encode(verification.credential_id),
    )

    return PasskeyResponse(
        id=_b64url_encode(cred.credential_id),
        name=cred.name,
        created_at=cred.created_at.isoformat(),
        last_used_at=None,
    )


# ---------------------------------------------------------------------------
# Authentication endpoint
# ---------------------------------------------------------------------------
@router.post("/authenticate")
async def authenticate_passkey(
    body: AuthenticateRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> TokenResponse:
    """Validate assertion and issue developer JWT."""
    settings = request.app.state.settings
    rp_id = settings.webauthn_rp_id
    origin = settings.webauthn_origin

    # Extract challenge from the credential response
    auth_resp_data = body.credential.get("response", {})
    auth_client_data_b64: str = auth_resp_data.get("clientDataJSON", "")
    try:
        auth_client_bytes = _b64url_decode(auth_client_data_b64)
        auth_client_data = json.loads(auth_client_bytes)
        auth_challenge_b64: str = auth_client_data.get("challenge", "")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid credential data")

    stored = _challenge_store.pop(auth_challenge_b64, None)
    if stored is None:
        raise HTTPException(status_code=400, detail="Challenge not found or expired")

    # Find the credential by credential_id from the assertion
    raw_id_b64: str = body.credential.get("rawId", "")
    try:
        credential_id_bytes = _b64url_decode(raw_id_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid credential ID")

    result = await session.execute(
        select(DeveloperCredential).where(
            DeveloperCredential.credential_id == credential_id_bytes
        )
    )
    cred = result.scalar_one_or_none()
    if cred is None:
        raise HTTPException(status_code=400, detail="Credential not recognized")

    try:
        verification = webauthn.verify_authentication_response(
            credential=body.credential,
            expected_challenge=_b64url_decode(auth_challenge_b64),
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=cred.public_key,
            credential_current_sign_count=cred.sign_count,
        )
    except Exception as exc:
        logger.error("passkey_authentication_failed", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail=f"Authentication verification failed: {exc}",
        )

    # Update sign count and last_used_at
    await session.execute(
        update(DeveloperCredential)
        .where(DeveloperCredential.id == cred.id)
        .values(
            sign_count=verification.new_sign_count,
            last_used_at=datetime.now(UTC),
        )
    )
    await session.commit()

    # Issue developer JWT
    private_key: Ed25519PrivateKey = request.app.state.jwt_private_key
    access = create_access_token(cred.developer_id, private_key)
    refresh = create_refresh_token(cred.developer_id, private_key)

    logger.info(
        "passkey_authenticated",
        developer_id=str(cred.developer_id),
    )

    return TokenResponse(access_token=access, refresh_token=refresh)


# ---------------------------------------------------------------------------
# List passkeys
# ---------------------------------------------------------------------------
@router.get("")
async def list_passkeys(
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> list[PasskeyResponse]:
    """List all passkeys for the authenticated developer."""
    result = await session.execute(
        select(DeveloperCredential)
        .where(DeveloperCredential.developer_id == developer_id)
        .order_by(DeveloperCredential.created_at.desc())
    )
    creds = result.scalars().all()
    return [
        PasskeyResponse(
            id=_b64url_encode(c.credential_id),
            name=c.name,
            created_at=c.created_at.isoformat(),
            last_used_at=c.last_used_at.isoformat() if c.last_used_at else None,
        )
        for c in creds
    ]


# ---------------------------------------------------------------------------
# Delete passkey
# ---------------------------------------------------------------------------
@router.delete("/{credential_id_b64}")
async def delete_passkey(
    credential_id_b64: str,
    developer_id: uuid.UUID = Depends(get_current_developer_id),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Delete a passkey credential."""
    try:
        credential_id_bytes = _b64url_decode(credential_id_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid credential ID")

    result = await session.execute(
        select(DeveloperCredential).where(
            DeveloperCredential.credential_id == credential_id_bytes,
            DeveloperCredential.developer_id == developer_id,
        )
    )
    cred = result.scalar_one_or_none()
    if cred is None:
        raise HTTPException(status_code=404, detail="Credential not found")

    await session.execute(
        delete(DeveloperCredential).where(DeveloperCredential.id == cred.id)
    )
    await session.commit()

    logger.info(
        "passkey_deleted",
        developer_id=str(developer_id),
        credential_id=credential_id_b64,
    )
    return {"status": "deleted"}
