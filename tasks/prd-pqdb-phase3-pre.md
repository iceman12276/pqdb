# PRD: pqdb Phase 3-pre — Security Hardening

## Introduction

Phase 3-pre is a short security hardening sprint that must complete before Phase 3a begins. It addresses rate limiting gaps identified during a Saltzer & Schroeder security architecture review (GitHub issues #49, #54). Phase 3 introduces significant new attack surface (Dashboard UI, MCP server, WebSocket realtime) — these gaps must be closed first.

Phase 3-pre builds on the existing rate limiting infrastructure (HMAC key endpoint, 10 req/min per project) and the Phase 2b auth endpoints that specified rate limits in their PRDs.

### Problem

1. **Incomplete rate limiting:** Only the HMAC key retrieval endpoint has rate limiting. Auth endpoints (login, signup, magic link, password reset, verification resend) may not have their PRD-specified rate limits implemented. CRUD endpoints and future WebSocket connections have no protection against flooding.

2. **Amplified risk in Phase 3:** The Dashboard, MCP server, and WebSocket server all introduce new endpoints and connection types. Without comprehensive rate limiting, these become DoS vectors.

### Solution

1. Audit and verify that all Phase 2b rate limits are implemented as specified in the Phase 2b PRD.

2. Expand rate limiting middleware to cover all auth endpoints, CRUD endpoints, and prepare the infrastructure for WebSocket connection limits (Phase 3b).

## Goals

- **G-1:** All Phase 2b PRD-specified rate limits verified as implemented
- **G-2:** Rate limiting middleware expanded to cover all auth + CRUD endpoints
- **G-3:** Rate limiting infrastructure supports per-project and per-IP policies
- **G-4:** Platform ready for Phase 3a without known security gaps

## User Stories

### US-PRE-1: Verify Phase 2b auth rate limits
**Description:** As a platform operator, I want to verify that all Phase 2b PRD-specified rate limits are implemented so that existing auth endpoints are protected before adding new attack surface.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Audit `backend/src/pqdb_api/routes/user_auth.py` for signup rate limit (10/min per IP) and login rate limit (20/min per IP)
- [ ] Audit `backend/src/pqdb_api/routes/verification.py` for email verification resend rate limit (3/min per email)
- [ ] Audit `backend/src/pqdb_api/routes/mfa.py` for MFA challenge rate limit
- [ ] Audit magic link endpoint for rate limit (5/min per email)
- [ ] Audit password reset endpoint for rate limit (5/min per email)
- [ ] For each missing rate limit: implement it matching the Phase 2b PRD specification
- [ ] Rate limit responses return HTTP 429 with `{"error": {"code": "rate_limited", "message": "..."}}`
- [ ] Unit tests pass (rate limit enforcement, 429 response format)
- [ ] Integration tests pass (rate limit triggers after threshold, resets after window)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-PRE-2: Expand rate limiting middleware
**Description:** As a platform operator, I want rate limiting on all CRUD and auth endpoints so that the platform is protected against flooding before Phase 3 adds new attack surface.

**Dependencies:** US-PRE-1

**Acceptance Criteria:**
- [ ] New `RateLimiter` middleware class supporting both per-IP and per-project limiting strategies
- [ ] CRUD endpoints (`/v1/db/*`) rate limited: 1000 requests/min per project
- [ ] Developer auth endpoints (`/v1/auth/signup`, `/v1/auth/login`, `/v1/auth/refresh`) rate limited: 20/min per IP
- [ ] Rate limiter uses sliding window algorithm (same as HMAC endpoint)
- [ ] Rate limiter is configurable via environment variables (`PQDB_RATE_LIMIT_CRUD`, `PQDB_RATE_LIMIT_AUTH`)
- [ ] Rate limit headers returned on all responses: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- [ ] Existing HMAC key rate limit migrated to use new `RateLimiter` class (consolidate implementations)
- [ ] Unit tests pass (sliding window, per-IP vs per-project, header format, env var override)
- [ ] Integration tests pass (rate limit enforcement on CRUD endpoints, auth endpoints, header verification)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### Dependency Graph

```
US-PRE-1: Verify Phase 2b rate limits   (Dependencies: None)
US-PRE-2: Expand rate limiting middleware (Dependencies: US-PRE-1)
```

Single chain — sequential execution:
```
US-PRE-1 → US-PRE-2
```

## Functional Requirements

- **FR-1:** All Phase 2b PRD-specified rate limits verified and implemented
- **FR-2:** CRUD endpoints rate limited per-project (1000 req/min default)
- **FR-3:** Developer auth endpoints rate limited per-IP (20 req/min default)
- **FR-4:** Rate limit headers (`X-RateLimit-*`) on all responses
- **FR-5:** Rate limits configurable via environment variables
- **FR-6:** 429 response with standard error format when rate exceeded
- **FR-7:** Single `RateLimiter` class replaces ad-hoc rate limiting implementations

## Non-Goals

- Distributed rate limiting (Redis-backed) — Phase 4, when multi-process/multi-region is needed
- WebSocket connection rate limiting — Phase 3b, when WebSocket is implemented
- Per-endpoint granular rate limits — simple per-project and per-IP is sufficient for Phase 3

## Technical Considerations

- **Backend:** Python 3.12+ / FastAPI. New `rate_limiter.py` middleware. In-memory sliding window (same as existing HMAC limiter).
- **Testing:** Integration tests require real FastAPI app with `TestClient`. Rate limit tests need time mocking or fast windows.
- **Environment variables:** `PQDB_RATE_LIMIT_CRUD=1000`, `PQDB_RATE_LIMIT_AUTH=20`, `PQDB_RATE_LIMIT_WINDOW=60` (seconds).

## Success Metrics

- **SM-1:** All Phase 2b rate limits verified as implemented
- **SM-2:** CRUD flooding test: 1001st request in 60s returns 429
- **SM-3:** Auth flooding test: 21st login attempt in 60s returns 429
- **SM-4:** Rate limit headers present on all API responses
- **SM-5:** Both stories have passing tests in CI

## Open Questions

- **OQ-1:** Should rate limits be different for `anon` vs `service` API keys? Current design treats them the same. Service key might need higher limits for batch operations.
