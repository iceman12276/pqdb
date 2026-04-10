# PRD: Envelope Encryption for Dashboard Auto-Decrypt

## Context

pqdb's dashboard requires developers to manually enter an encryption key in an "Unlock" dialog to decrypt sensitive columns. This is confusing — developers don't know what key to enter or where it came from. This feature makes encryption seamless: a per-project encryption key is auto-generated, wrapped with a key derived from the developer's password, and stored server-side. On login, the dashboard auto-derives the wrapping key and decrypts columns without any manual steps.

## Introduction

Envelope encryption wraps a randomly generated per-project encryption key with a key derived from the developer's login password (PBKDF2-SHA256). The wrapped blob is stored in the `projects` table. On login, the dashboard derives the same wrapping key client-side, unwraps the blob, and holds the encryption key in memory for automatic column decryption. The server never sees the unwrapped encryption key — zero-knowledge is preserved.

## Goals

1. Eliminate the manual "Unlock" dialog for password-authenticated developers
2. Auto-generate a per-project encryption key on project creation
3. Allow developers to reveal/copy the key for SDK use via project settings
4. Support password changes by re-wrapping all project keys (no data re-encryption)
5. Gracefully degrade for OAuth/passkey logins (fall back to manual unlock)

## User Stories

### US-001: Database Migration — Add wrapped_encryption_key Column

**Description:** As the system, I need a `wrapped_encryption_key` column on the projects table so that wrapped encryption key blobs can be stored per-project.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Alembic migration adds nullable `bytea` column `wrapped_encryption_key` to `projects`
- [ ] `Project` SQLAlchemy model includes `wrapped_encryption_key: Mapped[bytes | None]`
- [ ] Existing projects have `NULL` for this column (backward compatible)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-002: Dashboard Envelope Crypto Module

**Description:** As a developer, I need client-side crypto functions (PBKDF2 key derivation, AES-256-GCM wrap/unwrap, random key generation) so the dashboard can manage envelope encryption entirely in the browser.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] New module `dashboard/src/lib/envelope-crypto.ts` with functions:
  - `deriveWrappingKey(password, email) → CryptoKey` (PBKDF2-SHA256, 600K iterations)
  - `generateEncryptionKey() → string` (random 32 bytes, base64url)
  - `wrapKey(encryptionKey, wrappingKey) → Uint8Array` (AES-256-GCM)
  - `unwrapKey(wrappedBlob, wrappingKey) → string` (AES-256-GCM)
- [ ] All crypto uses WebCrypto API (`crypto.subtle`)
- [ ] Salt format: `"pqdb-envelope-v1:" + email` (UTF-8 encoded)
- [ ] Wrapped blob format: `nonce(12 bytes) || ciphertext+tag`
- [ ] Round-trip test: generate → wrap → unwrap → verify equality
- [ ] Wrong password fails unwrap (throws DOMException)
- [ ] Different emails produce different wrapping keys
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-003: Backend API — Store and Return Wrapped Encryption Key

**Description:** As the dashboard, I need backend endpoints to store and retrieve the wrapped encryption key blob so it persists across sessions and devices.

**Dependencies:** US-001

**Acceptance Criteria:**
- [ ] `POST /v1/projects` accepts optional `wrapped_encryption_key` (base64 string)
- [ ] `GET /v1/projects` and `GET /v1/projects/{id}` return `wrapped_encryption_key` (base64 string or null)
- [ ] New endpoint `PATCH /v1/projects/{id}/encryption-key` updates the wrapped blob (requires developer JWT)
- [ ] New endpoint `POST /v1/auth/change-password` accepts `{current_password, new_password}`, verifies old password, updates hash, returns new token pair
- [ ] Base64 encoding/decoding handled at API boundary (bytea in DB, base64 string in JSON)
- [ ] Integration tests: create project with wrapped key, verify returned in GET
- [ ] Integration tests: PATCH updates blob correctly
- [ ] Integration tests: change-password verifies old password, rejects wrong password
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-004: Dashboard — Generate and Wrap Key on Project Creation

**Description:** As a developer creating a project, I want an encryption key to be automatically generated and wrapped so I don't need to manage keys manually.

**Dependencies:** US-002, US-003

**Acceptance Criteria:**
- [ ] Project creation dialog generates a random encryption key via `generateEncryptionKey()`
- [ ] Key is wrapped with the wrapping key from `EnvelopeKeyProvider` context
- [ ] Wrapped blob is sent as `wrapped_encryption_key` in `POST /v1/projects`
- [ ] Unwrapped key is stored in `EnvelopeKeyProvider.encryptionKeys` map
- [ ] If no wrapping key is available (OAuth login), project is created without wrapped key
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Verify in browser

### US-005: Dashboard — Auto-Decrypt on Login

**Description:** As a developer logging in with a password, I want encrypted columns to automatically decrypt without needing to enter a separate encryption key.

**Dependencies:** US-002, US-003

**Acceptance Criteria:**
- [ ] New `EnvelopeKeyProvider` context at app root holds wrapping key + per-project encryption keys map
- [ ] Login page runs PBKDF2 derivation in parallel with login API call (hides latency)
- [ ] Signup page does the same (wrapping key ready for first project creation)
- [ ] After login, when projects are loaded, wrapped blobs are auto-unwrapped
- [ ] Projects with no `wrapped_encryption_key` (e.g. created via MCP server) auto-generate a key, wrap it, and PATCH to server when wrapping key is available — no user prompt needed
- [ ] Table detail pages auto-call `unlock(key)` on `EncryptionProvider` when envelope key is available
- [ ] Existing `EncryptionProvider` / `useEncryption()` API unchanged (backward compatible)
- [ ] Manual Unlock dialog remains functional as fallback (OAuth/passkey users)
- [ ] On page refresh, wrapping key is lost (CryptoKey not serializable) — encrypted columns show `[encrypted]` until re-login
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Verify in browser: login → navigate to table with encrypted columns → columns auto-decrypt

### US-006: Dashboard — Reveal Encryption Key in Project Settings

**Description:** As a developer, I want to reveal and copy my project's encryption key from the settings page so I can use it with the SDK.

**Dependencies:** US-005

**Acceptance Criteria:**
- [ ] Project settings page shows "Encryption Key" section
- [ ] "Reveal" button displays the key (from EnvelopeKeyProvider, already unwrapped in memory)
- [ ] "Copy" button copies key to clipboard
- [ ] "Hide" button re-hides the key
- [ ] Warning text: key is never stored by pqdb, store it securely, cannot be recovered if lost
- [ ] If no encryption key available (OAuth login, no wrapped blob), shows explanation message
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Verify in browser

### US-007: Password Change with Re-wrapping

**Description:** As a developer changing my password, I want all my project encryption keys to be re-wrapped with the new password so auto-decrypt continues working.

**Dependencies:** US-002, US-003, US-005

**Acceptance Criteria:**
- [ ] "Change Password" UI in account settings (dialog with current + new password fields)
- [ ] On submit: call `POST /v1/auth/change-password`, then re-wrap all project keys client-side
- [ ] Re-wrapping: unwrap each blob with old wrapping key, wrap with new wrapping key, PATCH each project
- [ ] Update wrapping key in EnvelopeKeyProvider
- [ ] No re-encryption of actual data needed (only the envelope changes)
- [ ] If re-wrapping fails for a project, skip it and warn (don't block password change)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Verify in browser

## Functional Requirements

- **FR-1:** The system must generate a random 32-byte encryption key per project on creation
- **FR-2:** The system must derive a 256-bit wrapping key from the developer's password using PBKDF2-SHA256 with 600K iterations and email-based salt
- **FR-3:** The system must wrap encryption keys using AES-256-GCM before storing on the server
- **FR-4:** The server must never receive or store unwrapped encryption keys
- **FR-5:** The dashboard must auto-decrypt encrypted columns on login without user interaction
- **FR-6:** The dashboard must allow revealing the raw encryption key in project settings for SDK use
- **FR-7:** Password changes must re-wrap all project keys without re-encrypting data
- **FR-8:** OAuth/passkey logins must degrade gracefully to manual unlock

## Non-Goals

- **Modifying SDK encryption** — SDK stays manual-key-only (`PQDB_ENCRYPTION_KEY` env var)
- **Modifying MCP server encryption** — MCP stays manual-key-only
- **SRP (Secure Remote Password)** — Server still sees password during auth (same trust model as Bitwarden)
- **Wrapping key persistence across page refresh** — CryptoKey objects can't be serialized; re-login required
- **Multi-device key sync** — Handled by server-side blob storage (any device with the password can unwrap)
- **Key recovery without password** — By design, lost password = lost keys (zero-knowledge)
- **Encrypting data from the dashboard** — Dashboard only decrypts; inserts still limited to plain columns

## Technical Considerations

### Crypto Design
- **Wrapping key:** `PBKDF2-SHA256(password, "pqdb-envelope-v1:" + email, 600K iterations, 256 bits)`
- **Wrapped blob:** `AES-256-GCM(nonce=12 bytes || ciphertext+tag)`
- **Encryption key:** Random 32 bytes → base64url string (~43 chars), passed to SDK's `deriveKeyPair()`
- **All crypto via WebCrypto API** (`crypto.subtle`) — no new dependencies

### Storage
- `wrapped_encryption_key bytea` nullable column on `projects` table
- Base64 encoding at API boundary (bytea in DB, base64 string in JSON)

### Performance
- PBKDF2 with 600K iterations: ~300-500ms in browser
- Login flow runs PBKDF2 in parallel with API call (hidden latency)
- Wrapping key held in memory for session (derived once, not per-navigation)

### Key Files to Modify/Create
| File | Action |
|------|--------|
| `backend/alembic/versions/007_add_wrapped_encryption_key.py` | Create |
| `backend/src/pqdb_api/models/project.py` | Modify — add column |
| `backend/src/pqdb_api/routes/projects.py` | Modify — accept/return blob, add PATCH |
| `backend/src/pqdb_api/routes/auth.py` | Modify — add change-password endpoint |
| `dashboard/src/lib/envelope-crypto.ts` | Create — PBKDF2, AES-GCM, key gen |
| `dashboard/src/lib/envelope-key-context.tsx` | Create — wrapping key + keys map context |
| `dashboard/src/components/login-page.tsx` | Modify — parallel PBKDF2 + login |
| `dashboard/src/components/create-project-dialog.tsx` | Modify — generate + wrap key |
| `dashboard/src/routes/__root.tsx` | Modify — wrap with EnvelopeKeyProvider |
| `dashboard/src/routes/projects/$projectId/tables/$tableName.tsx` | Modify — auto-unlock |
| `dashboard/src/routes/projects/$projectId/settings.tsx` | Modify — reveal key UI |

### Dependency Graph
```
US-001 (schema) ──────┐
                      ├──→ US-003 (API) ──┬──→ US-004 (create flow)
US-002 (crypto) ──────┘                   ├──→ US-005 (auto-decrypt) ──→ US-006 (reveal key)
                                          └──→ US-007 (password change)
```

Parallel groups:
1. **US-001 + US-002** (independent)
2. **US-003** (needs US-001)
3. **US-004 + US-005** (need US-002 + US-003, independent of each other)
4. **US-006** (needs US-005)
5. **US-007** (needs US-002 + US-003 + US-005)

## Success Metrics

- Developer logs in → navigates to table with encrypted columns → columns show decrypted values without any manual step
- Developer copies encryption key from settings → uses in SDK → SDK decrypts same data
- Developer changes password → auto-decrypt continues working on next login

## Open Questions

1. **PBKDF2 iteration count in tests** — 600K iterations makes tests slow. Should we use a lower count (e.g., 1000) in test environments via a mockable constant?
2. **Page refresh UX** — On refresh, wrapping key is lost. Should we show a subtle "Enter password to re-enable auto-decrypt" prompt, or just show `[encrypted]` until re-login?
