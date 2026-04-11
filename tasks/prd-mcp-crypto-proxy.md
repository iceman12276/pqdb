# PRD: Local Crypto Proxy for Hosted MCP

## Introduction

pqdb's MCP server currently handles both API proxy operations and client-side encryption in the same process. The private key lives in a `PQDB_PRIVATE_KEY` env var. For production, the MCP server will be hosted — putting a developer's private key on a shared server breaks zero-knowledge. This feature splits the MCP into a hosted core (no crypto, passes ciphertext through) and a local crypto proxy (runs on the developer's machine, intercepts tool calls for encryption/decryption).

## Goals

1. **Zero-knowledge in production**: The hosted MCP server never touches private keys, plaintext data, or shared secrets
2. **Transparent to AI agents**: Claude Code sees the exact same MCP tools whether connecting directly or through the proxy
3. **Simple developer setup**: Auto-discover the recovery file, no manual base64 extraction
4. **No code duplication**: Reuse existing SDK crypto functions (transformInsertRows, transformFilters, transformSelectResponse, encapsulate, decapsulate)

## User Stories

### US-010: Recovery File Discovery and Private Key Loading

**Description:** As a developer setting up the crypto proxy, I want the proxy to automatically find my recovery file so I don't have to manually extract and paste a base64 private key.

**Dependencies:** None

**Acceptance Criteria:**
- New file `mcp/src/proxy/recovery.ts` exports `discoverRecoveryFile(explicitPath?: string): string` and `loadPrivateKeyFromRecovery(path: string): Uint8Array`
- Discovery order: `--recovery-file <path>` flag > `~/.pqdb/recovery.json` > most recent `~/Downloads/pqdb-recovery-*.json` (by mtime)
- Validates decoded key is exactly 2400 bytes (ML-KEM-768 private key)
- Rejects invalid JSON with clear error: "Recovery file is not valid JSON"
- Rejects missing `private_key` field with clear error: "Recovery file missing private_key field"
- Rejects wrong key length with clear error: "Private key must be exactly 2400 bytes (ML-KEM-768), got {length}"
- When no recovery file found: error message lists all locations checked and suggests where to save it
- Unit tests at `mcp/tests/unit/recovery.test.ts` cover: explicit path, ~/.pqdb fallback, ~/Downloads glob, missing file, invalid JSON, wrong key length
- Unit tests pass
- Typecheck passes
- CI passes

### US-011: Upstream MCP Client

**Description:** As the crypto proxy, I need to connect to the hosted MCP server as an MCP client so I can forward tool calls and receive responses.

**Dependencies:** None

**Acceptance Criteria:**
- New file `mcp/src/proxy/upstream-client.ts` exports `UpstreamClient` class
- Constructor takes `targetUrl: string` and optional `authHeaders: Record<string, string>`
- `connect()` establishes StreamableHTTPClientTransport connection to the hosted MCP
- `listTools()` returns all tools from the hosted MCP with their names, descriptions, and input schemas
- `callTool(name: string, args: Record<string, unknown>)` forwards a tool call and returns the result
- `close()` cleanly disconnects
- Handles connection errors with clear error messages (connection refused, timeout, auth failure)
- Unit test at `mcp/tests/unit/upstream-client.test.ts`: mock transport, verify connect/list/call/close lifecycle
- Unit tests pass
- Typecheck passes
- CI passes

### US-012: Crypto Interceptor

**Description:** As the crypto proxy, I need to intercept crypto-relevant tool calls, encrypt data before forwarding to the hosted MCP, and decrypt responses before returning to Claude Code.

**Dependencies:** US-010

**Acceptance Criteria:**
- New file `mcp/src/proxy/crypto-interceptor.ts` exports `CryptoInterceptor` class and `isCryptoTool(name: string): boolean`
- `isCryptoTool` returns true for: pqdb_insert_rows, pqdb_query_rows, pqdb_update_rows, pqdb_delete_rows, pqdb_create_project, pqdb_select_project, pqdb_natural_language_query
- `transformRequest(toolName, args)` encrypts/transforms arguments before forwarding:
  - insert: transformInsertRows (encrypt values + compute HMAC blind indexes)
  - query: transformFilters (HMAC-hash filter values on searchable columns)
  - update: both transformInsertRows (values) and transformFilters (filters)
  - delete: transformFilters (filters)
  - create_project: encapsulate(publicKey), add wrapped_encryption_key to args
- `transformResponse(toolName, result, metadata)` decrypts/transforms responses after receiving:
  - query: transformSelectResponse (decrypt _encrypted columns)
  - select_project: decapsulate(wrappedKey, privateKey), store shared secret
  - natural_language_query: decrypt _encrypted columns in response data
- Fetches table schema from backend `/v1/db/introspect` for column sensitivity info
- Fetches HMAC key from backend `/v1/db/hmac-key` for blind index computation
- Reuses ALL crypto functions from `@pqdb/client` — no duplication
- create_project: fetches developer's public key via GET /v1/auth/me/public-key, calls encapsulate(), stores shared secret
- select_project: calls decapsulate() with private key, stores shared secret for subsequent CRUD
- Non-crypto tools return args/results unchanged
- Unit tests at `mcp/tests/unit/crypto-interceptor.test.ts` cover all 7 crypto tools + passthrough
- Unit tests pass
- Typecheck passes
- CI passes

### US-013: Proxy Server Assembly

**Description:** As the crypto proxy, I need to combine the upstream client and crypto interceptor into a functioning MCP server that dynamically registers all tools from the hosted MCP.

**Dependencies:** US-011, US-012

**Acceptance Criteria:**
- New file `mcp/src/proxy/proxy-server.ts` exports `createCryptoProxyServer(config: ProxyConfig)`
- On startup: connects to upstream, calls listTools(), registers each tool on the local McpServer
- For crypto tools: handler calls interceptor.transformRequest → upstream.callTool → interceptor.transformResponse
- For non-crypto tools: handler calls upstream.callTool directly → returns result as-is
- New tools added to the hosted MCP are automatically available through the proxy without code changes
- New file `mcp/src/proxy/index.ts` with barrel exports
- Integration test at `mcp/tests/unit/proxy-server.test.ts` using a real hosted MCP instance (the existing server in full mode) connected via in-process transport
- Integration test proves: non-crypto tool passthrough, insert with encryption, query with decryption, create_project with encapsulation
- Unit tests pass
- Typecheck passes
- Production build succeeds
- CI passes

### US-014: CLI Integration and Developer Experience

**Description:** As a developer, I want to start the crypto proxy with a simple CLI command that auto-discovers my recovery file and connects to a hosted MCP server.

**Dependencies:** US-010, US-013

**Acceptance Criteria:**
- `mcp/src/cli.ts` updated: `--mode proxy` flag routes to proxy startup
- `mcp/src/config.ts` updated: parses `--mode`, `--target`, `--recovery-file` args
- `node mcp/dist/cli.js --mode proxy --target http://localhost:3002/mcp` starts the proxy on stdio
- Recovery file auto-discovered (or overridden with --recovery-file)
- `--mode full` (or no --mode) retains existing behavior exactly — zero regression
- When recovery file not found: clear error with instructions
- Startup log: `[pqdb-proxy] Crypto proxy → <target-url> (key from <recovery-file-path>)`
- Unit tests for CLI arg parsing
- Manual verification: connect Claude Code to the proxy via stdio, create encrypted project, insert data, query back
- Unit tests pass
- Typecheck passes
- Production build succeeds
- CI passes

## Functional Requirements

- FR-1: The proxy MUST expose the exact same MCP tool set as the hosted server
- FR-2: The proxy MUST encrypt all sensitive column values before forwarding to the hosted MCP
- FR-3: The proxy MUST decrypt all encrypted column values in responses before returning to Claude Code
- FR-4: The proxy MUST handle ML-KEM encapsulate/decapsulate for project create/select locally
- FR-5: The private key MUST never leave the developer's machine (never sent to the hosted MCP or backend)
- FR-6: The shared secret MUST never appear in any tool response (same security invariant as Phase 5d)
- FR-7: The proxy MUST fail fast with clear errors when the recovery file is missing or invalid

## Non-Goals

- Hosting the proxy as a service (it's always local by design)
- Supporting multiple recovery files / multiple developer keys simultaneously
- Key rotation through the proxy (use the dashboard for that)
- Proxy-to-proxy chaining
- Windows-specific file path handling (follow Node.js cross-platform patterns, but don't special-case Windows)

## Technical Considerations

- The MCP SDK (`@modelcontextprotocol/sdk`) supports both Server and Client in the same package — no new dependencies needed
- `StreamableHTTPClientTransport` handles the HTTP connection to the hosted MCP
- The proxy uses stdio transport to Claude Code (standard for local MCP servers in `.mcp.json`)
- Schema and HMAC key caching: reuse the same TTL pattern from crud-tools.ts (60s schema cache)
- The proxy must handle the hosted MCP's OAuth flow — when the upstream requires auth, the proxy needs to forward the developer's credentials or use a pre-configured JWT

## Success Metrics

- Zero plaintext data visible in network traffic between proxy and hosted MCP
- All existing MCP tools work identically through the proxy
- Developer setup takes < 2 minutes (download recovery file, run one command)
- No regression in existing `--mode full` behavior

## Open Questions

1. How should the proxy authenticate to the hosted MCP? (Forward the developer's OAuth JWT? Use a separate API key?)
2. Should the proxy support SSE transport to the upstream, or only StreamableHTTP?
3. Should the dashboard suggest `~/.pqdb/recovery.json` as the save location during signup?
