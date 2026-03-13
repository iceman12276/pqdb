# PQC Crypto Evaluation Spike — Results

**Date:** 2026-03-13
**Story:** US-016
**Goal:** Evaluate PQC WASM/JS libraries for the TypeScript SDK to choose the right ML-KEM-768 implementation for client-side encryption and identify an HMAC-SHA3-256 implementation for blind indexing.

## Candidates Evaluated

### ML-KEM-768 Implementations

| Library | Version | Bundle Size | Standard | Language | Node.js | Browser |
|---------|---------|-------------|----------|----------|---------|---------|
| **@noble/post-quantum** | 0.5.4 | 416 KB (+1.5 MB @noble/curves dep) | FIPS 203 (ML-KEM) | Pure JS/TS | Yes | Yes |
| **mlkem** | 2.7.0 | 700 KB | FIPS 203 (ML-KEM) | Pure TS | Yes | Yes |
| **mlkem-wasm** | 0.0.7 | 92 KB | FIPS 203 (ML-KEM) | WASM (C) | Partial | Yes |
| **pqc-kyber** | 0.7.0 | 120 KB | Kyber R3 (pre-FIPS) | WASM (Rust) | No | Partial |
| **kyber-crystals** | 1.0.7 | 93 KB | Kyber R3 (pre-FIPS) | WASM | Unknown | Yes |

### ML-KEM-768 Latency (Node.js 22, 100 iterations, after warmup)

| Library | Keygen (ms) | Encaps (ms) | Decaps (ms) |
|---------|-------------|-------------|-------------|
| **@noble/post-quantum** | 0.384 | 0.363 | 0.339 |
| **mlkem** | 0.205 | 0.179 | 0.188 |
| **mlkem-wasm** | N/A (API issues) | N/A | N/A |
| **pqc-kyber** | N/A (WASM load error) | N/A | N/A |

### HMAC-SHA3-256 Implementations

| Library | Version | Bundle Size | Notes |
|---------|---------|-------------|-------|
| **@noble/hashes** | 2.0.1 | 876 KB (full) | Tree-shakeable; SHA3 + HMAC subpaths. Audited. Zero deps. |
| **js-sha3** | 0.9.3 | ~50 KB | SHA3 only, no HMAC built-in — would need manual HMAC construction. |

## Detailed Analysis

### @noble/post-quantum (Recommended)

**Pros:**
- Audited by a reputable security firm (Cure53)
- Part of the noble cryptography suite (widely used, well-maintained by paulmillr)
- Pure JS — no WASM loading complexity, works everywhere (Node.js, browsers, edge runtimes)
- FIPS 203 compliant (final ML-KEM standard, not pre-FIPS Kyber)
- Already depends on `@noble/hashes` (which we need for HMAC-SHA3-256)
- Synchronous API — simple to use, easy to wrap as async for future WASM migration
- MIT license
- Actively maintained (last published 2025-12-22)
- Includes ML-DSA and SLH-DSA for future use (digital signatures)

**Cons:**
- ~2x slower than `mlkem` in microbenchmarks (still sub-millisecond)
- Pulls in `@noble/curves` as a dependency (1.5 MB), though tree-shaking removes unused code in production builds

### mlkem

**Pros:**
- Fastest pure TS implementation tested
- FIPS 203 compliant
- Clean TypeScript API
- Actively maintained (published 2026-03-08)

**Cons:**
- No published security audit
- Does not include HMAC/SHA3 — would need a separate library
- Async-only API (minor consideration)
- Less ecosystem presence than noble suite

### mlkem-wasm

**Pros:**
- Smallest bundle (92 KB)
- Native WASM performance potential
- FIPS 203 compliant

**Cons:**
- WebCrypto-like API with CryptoKey objects — adds complexity for raw key access
- Failed to run basic encapsulate in Node.js 22 testing (API incompatibilities)
- Very early version (0.0.7) — limited documentation and community
- Single maintainer

### pqc-kyber

**Pros:**
- Rust-based WASM (potentially high performance)
- Small bundle (120 KB)

**Cons:**
- Implements pre-FIPS Kyber R3, NOT the final FIPS 203 ML-KEM standard
- WASM loading fails in Node.js without bundler support (ERR_UNKNOWN_FILE_EXTENSION)
- No `main` or `exports` in package.json — ESM-only with `module` field
- Last published 2023-08-15 — appears unmaintained
- Would need to compile a custom WASM build for ML-KEM compliance

### kyber-crystals

**Not benchmarked.** Implements pre-FIPS Kyber, not ML-KEM. Last published 2023-07-17 — effectively abandoned.

## Recommendation

### Primary: `@noble/post-quantum` + `@noble/hashes`

Use `@noble/post-quantum` for ML-KEM-768 and `@noble/hashes` for HMAC-SHA3-256.

**Rationale:**
1. **Security audit** — The noble suite has been audited by Cure53. For a security-critical product (client-side encryption of sensitive data), audit status is the single most important criterion.
2. **FIPS 203 compliance** — Implements the final NIST standard, not the draft Kyber specification.
3. **Ecosystem coherence** — `@noble/post-quantum` already depends on `@noble/hashes`, which provides HMAC-SHA3-256. One dependency tree for all crypto needs.
4. **Universal runtime support** — Pure JS works in Node.js, all browsers, Deno, Bun, Cloudflare Workers, and edge runtimes without WASM loading hacks.
5. **Performance is sufficient** — Sub-millisecond operations. The ~0.2ms difference vs `mlkem` is negligible in a network round-trip context.
6. **Future-proof** — Also includes ML-DSA (FIPS 204) for digital signatures if needed in Phase 2 (PQC TLS).

### Fallback Strategy

If `@noble/post-quantum` has issues (e.g., critical vulnerability, unmaintained):

1. **First fallback: `mlkem`** — Same FIPS 203 standard, faster, actively maintained. Would need to add a separate HMAC-SHA3-256 library (`@noble/hashes` can still be used independently).
2. **Second fallback: `mlkem-wasm`** — If pure JS performance becomes insufficient in browser contexts, revisit WASM implementations once `mlkem-wasm` matures and fixes Node.js compatibility.
3. **Long-term: WebCrypto ML-KEM** — Browser vendors are working on native ML-KEM support in the WebCrypto API. When available, this would be the ideal zero-dependency solution.

### HMAC-SHA3-256

**Choice: `@noble/hashes`**

- Already a transitive dependency of `@noble/post-quantum`
- Provides `hmac()` + `sha3_256` via tree-shakeable subpath imports
- Audited (Cure53)
- Zero dependencies
- `randomBytes()` utility for key generation

## Proof of Concept

The PoC implementation is in `sdk/src/crypto/`:

- `pqc.ts` — ML-KEM-768 keygen/encapsulate/decapsulate wrapper
- `hmac.ts` — HMAC-SHA3-256 wrapper with key generation

Tests in `sdk/tests/crypto/`:

- `pqc.test.ts` — Round-trip test: keygen → encapsulate → decapsulate → verify shared secrets match
- `hmac.test.ts` — Determinism, key isolation, and data isolation tests

All tests pass. Typecheck passes. Build succeeds.
