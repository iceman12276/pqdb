"""Email verification enforcement logic (US-032).

Pure functions that decide whether CRUD access should be blocked
based on email verification status and project settings.
"""

from __future__ import annotations

# 24 hours in seconds
VERIFICATION_TOKEN_EXPIRY_SECONDS = 86400


def should_enforce_email_verification(
    *,
    require_email_verification: bool,
    email_verified: bool,
    key_role: str,
    has_owner_column: bool,
    has_user_context: bool,
) -> bool:
    """Decide whether to block CRUD access for unverified email.

    Returns True if the request should be denied (403).

    Conditions for enforcement (all must be true):
    - require_email_verification is enabled in auth settings
    - User is NOT email_verified
    - API key role is NOT 'service' (service role bypasses)
    - Table has an owner column
    - User context is present (authenticated user)
    """
    if not require_email_verification:
        return False
    if email_verified:
        return False
    if key_role == "service":
        return False
    if not has_owner_column:
        return False
    if not has_user_context:
        return False
    return True
