# PRD: pqdb Phase 3b — MCP + Vector Search + Realtime

## Introduction

Phase 3b extends pqdb with AI agent integration (MCP server), vector similarity search (pgvector), and realtime subscriptions (WebSocket). These are data-layer features that make pqdb competitive with Supabase's full feature set while preserving the zero-knowledge guarantee. Phase 3b also adds Dashboard pages for MCP and Realtime configuration.

Phase 3b builds on Phase 3a's Dashboard (sidebar, project pages) and the complete Phase 1/2 foundation (CRUD, schema engine, auth, RLS).

### Problem

1. **No AI agent integration:** AI agents (Claude, GPT, Cursor) cannot interact with pqdb. Developers building AI-powered applications need their agents to query schemas and read/write data via MCP.

2. **No vector search:** pgvector is enabled but not exposed. Developers cannot perform similarity search despite having `vector(N)` columns. No `.similarTo()` in the SDK, no vector search endpoint in the API.

3. **No realtime:** Developers must poll the API to detect data changes. For chat apps, collaborative tools, and live dashboards, polling is wasteful and adds latency.

4. **No Dashboard pages for MCP/Realtime:** The Phase 3a Dashboard has grayed-out sidebar items for MCP and Realtime that need to be activated.

### Solution

1. A standalone TypeScript MCP server in `/mcp` that imports `@pqdb/client` directly. Supports stdio + SSE transports. Exposes schema, CRUD, auth, and natural-language-to-query tools.

2. Vector similarity search: new `similar_to` field on the select endpoint, supporting cosine/L2/inner product distance metrics. SDK `.similarTo()` method. Vector index management (HNSW, IVFFlat).

3. Realtime subscriptions: PostgreSQL LISTEN/NOTIFY triggers, WebSocket server embedded in FastAPI, per-subscriber RLS enforcement, SDK `.on().subscribe()` with auto-reconnect and client-side decryption.

4. Dashboard MCP page (connection config, tool list) and Realtime page (subscription inspector, connection stats).

## Goals

- **G-1:** AI agents can interact with pqdb via MCP protocol — schema discovery, CRUD operations, auth queries
- **G-2:** MCP server optionally decrypts sensitive columns when developer provides encryption key
- **G-3:** Natural language queries translated to pqdb SDK queries via rule-based pattern matching
- **G-4:** Developers can perform vector similarity search via SDK `.similarTo()` and API `similar_to` parameter
- **G-5:** Vector columns validated as `plain` only — encrypted vectors rejected at schema creation time
- **G-6:** Developers can create/manage HNSW and IVFFlat vector indexes
- **G-7:** Developers can subscribe to table changes in real-time via WebSocket
- **G-8:** Realtime events respect RLS — subscribers only receive events for rows they'd be allowed to read
- **G-9:** SDK decrypts sensitive columns in realtime event payloads before delivering to callbacks
- **G-10:** Dashboard MCP and Realtime pages provide configuration and monitoring UI
- **G-11:** E2E round-trip proven: MCP agent query, vector search, realtime subscription with RLS

## User Stories

### US-056: MCP server scaffolding
**Description:** As a developer, I want an MCP server scaffolded so that AI agents can connect to my pqdb project.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `/mcp` directory with TypeScript project: `package.json`, `tsconfig.json`, `src/` structure
- [ ] Dependencies: `@modelcontextprotocol/sdk`, `@pqdb/client` (workspace link)
- [ ] MCP server entry point supporting `--project-url` and `--transport` (stdio default, sse optional) CLI args
- [ ] Authentication via `PQDB_API_KEY` environment variable — passed to `@pqdb/client` as API key
- [ ] Optional `PQDB_ENCRYPTION_KEY` — when provided, enables client-side decryption via SDK
- [ ] stdio transport: reads from stdin, writes to stdout (standard MCP pattern)
- [ ] SSE transport: HTTP server on configurable port (default 3001)
- [ ] Server announces capabilities on connection (tools + resources)
- [ ] `npm run build` produces production bundle
- [ ] `npm run typecheck` passes
- [ ] Unit tests pass (server starts, announces capabilities, auth configured)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-057: MCP schema tools + resources
**Description:** As an AI agent, I want to discover and understand the pqdb schema so that I can formulate correct queries.

**Dependencies:** US-056

**Acceptance Criteria:**
- [ ] Tool `pqdb_list_tables`: returns all tables with column count and sensitivity summary
- [ ] Tool `pqdb_describe_table`: returns full schema for a table — columns, types, sensitivity levels, valid operations
- [ ] Tool `pqdb_describe_schema`: returns ERD-style overview of all tables with foreign key relationships
- [ ] MCP Resource `pqdb://tables`: list of table names
- [ ] MCP Resource `pqdb://tables/{name}`: column schema for a specific table
- [ ] MCP Resource `pqdb://tables/{name}/stats`: row count and sensitivity summary
- [ ] All tools call `GET /v1/db/introspect` and `GET /v1/db/introspect/{table}` via `@pqdb/client` HTTP client
- [ ] Resources are read-only and require no API key role restriction
- [ ] Unit tests pass (tool responses match expected schema, resources return correct data)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-058: MCP CRUD tools
**Description:** As an AI agent, I want to read and write data in pqdb so that I can perform database operations on behalf of the developer.

**Dependencies:** US-057

**Acceptance Criteria:**
- [ ] Tool `pqdb_query_rows`: accepts table, columns, filters, limit, offset, order_by parameters. Calls `POST /v1/db/{table}/select`
- [ ] Tool `pqdb_insert_rows`: accepts table and rows array. Calls `POST /v1/db/{table}/insert`
- [ ] Tool `pqdb_update_rows`: accepts table, filters, and update values. Calls `POST /v1/db/{table}/update`
- [ ] Tool `pqdb_delete_rows`: accepts table and filters. Calls `POST /v1/db/{table}/delete`
- [ ] When `PQDB_ENCRYPTION_KEY` is set: sensitive columns in query results are decrypted before returning to agent; insert values for sensitive columns are encrypted before sending to API
- [ ] When `PQDB_ENCRYPTION_KEY` is not set: sensitive columns return `[encrypted]` in query results; inserts for sensitive columns return an error explaining encryption key is required
- [ ] All tools return structured responses with `data` and `error` fields
- [ ] Unit tests pass (tool input validation, API call payloads, encrypted vs unencrypted responses)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-059: MCP auth tools + natural language query
**Description:** As an AI agent, I want to query users/roles/policies and use natural language for queries so that I can assist developers with auth management and data exploration.

**Dependencies:** US-058

**Acceptance Criteria:**
- [ ] Tool `pqdb_list_users`: lists end-users (requires service API key). Calls `GET` or appropriate user listing endpoint
- [ ] Tool `pqdb_list_roles`: lists configured roles. Calls `GET /v1/projects/{id}/auth/roles`
- [ ] Tool `pqdb_list_policies`: accepts table name, lists RLS policies. Calls `GET /v1/db/tables/{name}/policies`
- [ ] Tool `pqdb_natural_language_query`: accepts natural language string, translates to pqdb query, executes, returns results
- [ ] NL translation is rule-based pattern matching using schema metadata:
  - "find users where email is X" → `.from(users).select().eq('email', 'X')`
  - "show all posts" → `.from(posts).select()`
  - "get orders after DATE" → `.from(orders).select().gt('created_at', 'DATE')`
  - "show me the schema" → calls `pqdb_describe_schema`
- [ ] NL translation respects sensitivity: won't attempt `.gt()` on searchable columns, returns error explaining constraint
- [ ] Queries that can't be translated return clear error with supported patterns
- [ ] `pqdb_query_rows` gains `similar_to` parameter support (for Phase 3b vector search integration)
- [ ] Unit tests pass (NL pattern matching, sensitivity constraints, auth tool responses, similar_to parameter)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-060: Vector similarity search backend
**Description:** As a developer, I want vector similarity search on the backend so that I can query embeddings stored in pgvector columns.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `POST /v1/db/{table}/select` gains optional `similar_to` field: `{ column, vector, limit, distance }`
- [ ] Supported distance metrics: `cosine` (`<=>`), `l2` (`<->`), `inner_product` (`<#>`)
- [ ] Default distance metric: `cosine`
- [ ] Generated SQL: `SELECT ... FROM {table} WHERE {filters} ORDER BY {column} <=> '{vector}' LIMIT {limit}`
- [ ] Validation: `similar_to.column` must be `plain` type `vector(N)` — reject if sensitive or wrong type with clear error
- [ ] Validation: vector dimension must match column's declared dimension — reject on mismatch
- [ ] Validation: `similar_to` cannot be combined with `order_by` — reject with error
- [ ] Validation: `similar_to.limit` is required (no unbounded scans)
- [ ] `similar_to` field is `Optional` — requests without it work identically to Phase 1/2 (backward compatible)
- [ ] Schema engine rejects `column.vector(N).sensitive('searchable')` and `.sensitive('private')` with clear error
- [ ] Unit tests pass (query generation, distance metrics, all validation rules)
- [ ] Integration tests pass (insert vectors → similarity query → correct top-K results)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-061: Vector index management
**Description:** As a developer, I want to create and manage vector indexes so that similarity search is fast on large datasets.

**Dependencies:** US-060

**Acceptance Criteria:**
- [ ] `POST /v1/db/tables/{name}/indexes` creates a vector index: accepts `{ column, type, distance }`
- [ ] Supported index types: `hnsw` (fast approximate), `ivfflat` (memory-efficient)
- [ ] Index names auto-generated: `idx_{table}_{column}_{type}` (e.g., `idx_documents_embedding_hnsw`)
- [ ] Generated SQL: `CREATE INDEX idx_... ON {table} USING hnsw ({column} {operator_class})` or `ivfflat`
- [ ] Operator class mapped from distance: cosine → `vector_cosine_ops`, l2 → `vector_l2_ops`, inner_product → `vector_ip_ops`
- [ ] `GET /v1/db/tables/{name}/indexes` lists existing indexes (name, column, type, distance)
- [ ] `DELETE /v1/db/tables/{name}/indexes/{index_name}` drops index by PostgreSQL name
- [ ] Dashboard Schema page gains "Indexes" section showing vector indexes with "Create Index" and "Drop" buttons (integrates into US-048's schema page)
- [ ] Validation: index column must be `plain` type `vector(N)`
- [ ] Returns 409 if index already exists for that column + type
- [ ] Unit tests pass (index creation SQL, listing, deletion, validation)
- [ ] Integration tests pass (create index → verify in pg_indexes → drop → verify removed)
- [ ] Service responds to health check
- [ ] Verify in browser (Dashboard index management)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-062: SDK vector search
**Description:** As a developer using the SDK, I want a `.similarTo()` method so that I can perform vector similarity search from my application.

**Dependencies:** US-060

**Acceptance Criteria:**
- [ ] `client.from(table).select(...).similarTo(column, vector, { limit, distance })` method on query builder
- [ ] `.similarTo()` adds `similar_to` field to the select request payload
- [ ] `.similarTo()` can be combined with `.eq()` and other filters (pre-filtering before vector search)
- [ ] `.similarTo()` cannot be combined with `.order()` — throws clear error
- [ ] `distance` parameter defaults to `'cosine'`, accepts `'l2'` and `'inner_product'`
- [ ] SDK decrypts sensitive columns in results as usual (vector search determines which rows, encryption is transparent)
- [ ] TypeScript types enforce vector parameter as `number[]`
- [ ] `{ data, error }` return pattern — never throws
- [ ] Unit tests pass (query builder payloads, validation, combined with filters, type inference)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-063: Realtime PostgreSQL triggers + NOTIFY
**Description:** As a platform operator, I want PostgreSQL triggers that notify on data changes so that the realtime server can relay events to subscribers.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `pqdb_notify_changes()` trigger function created: sends `{ table, event, pk }` via `pg_notify('pqdb_realtime', ...)`
- [ ] Trigger sends only primary key (not full row) to stay under pg_notify 8KB limit
- [ ] Primary key hardcoded as `id` column (matches schema engine convention)
- [ ] `DELETE` events send `OLD.id`, `INSERT`/`UPDATE` events send `NEW.id`
- [ ] Trigger per table: `CREATE TRIGGER pqdb_realtime_trigger AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION pqdb_notify_changes()`
- [ ] Trigger installation function: `install_realtime_trigger(table_name)` — idempotent, skips if trigger already exists
- [ ] Triggers installed permanently on first subscription — no cleanup on unsubscribe
- [ ] Each project database has its own `pqdb_realtime` channel (isolation by database separation)
- [ ] Unit tests pass (trigger function SQL, payload format, idempotent installation)
- [ ] Integration tests pass (insert row → pg_notify fires → payload matches expected format)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-064: Realtime WebSocket server
**Description:** As a developer, I want a WebSocket endpoint so that my application can subscribe to table changes in real-time.

**Dependencies:** US-063

**Acceptance Criteria:**
- [ ] WebSocket endpoint at `ws://localhost:8000/v1/realtime`
- [ ] Authentication via query parameters: `apikey` (required) + `token` (optional user JWT)
- [ ] Connection handshake: validates API key, extracts project context, establishes LISTEN on project database
- [ ] Protocol: client sends `{ type: "subscribe", table, events }` → server responds with `{ type: "ack", subscription_id }`
- [ ] Protocol: server sends `{ type: "event", subscription_id, event, row }` on table changes
- [ ] Protocol: client sends `{ type: "unsubscribe", subscription_id }` → server removes subscription
- [ ] Server heartbeat every 30 seconds: `{ type: "heartbeat" }`
- [ ] On NOTIFY: server fetches full row via SQL (`SELECT * FROM {table} WHERE id = {pk}`), delivers to subscribers
- [ ] For DELETE events: delivers `{ event: "delete", row: { id: pk } }` (no full row fetch)
- [ ] Connection management: track active subscriptions per connection, max 50 tables per connection
- [ ] Reconnect rate limiting: max 5 reconnects/min per IP
- [ ] Embedded in FastAPI via Starlette WebSocket support — shares auth middleware and DB pool
- [ ] Unit tests pass (protocol parsing, subscription management, heartbeat)
- [ ] Integration tests pass (WebSocket connects, subscribes, receives events on insert)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-065: Realtime RLS enforcement
**Description:** As a platform operator, I want realtime events filtered by RLS policies so that subscribers only see events they're authorized to see.

**Dependencies:** US-064

**Acceptance Criteria:**
- [ ] Per-event, per-subscriber RLS check before delivery:
  1. Extract user role from JWT (or `anon` if no JWT)
  2. Look up policy for `(table, select, role)` in `_pqdb_policies`
  3. `none` → don't deliver event
  4. `all` → deliver event
  5. `owner` → deliver only if `row[owner_column] == subscriber.user_id`
- [ ] Service role API key always receives all events (admin bypass)
- [ ] Tables with no policies and no owner column: all roles receive events (Phase 1 open access)
- [ ] Tables with policies but no matching policy for subscriber's role: deny (default none)
- [ ] Fallback: tables with no policies but with owner column → basic owner-column RLS (Phase 2a compat)
- [ ] RLS check uses fetched row data (from US-064's full row fetch) — no additional DB query
- [ ] Unit tests pass (all RLS conditions, role extraction, owner matching, fallback behavior)
- [ ] Integration tests pass (subscriber with owner policy receives only own rows; service role receives all; anon with none policy receives nothing)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-066: SDK realtime client
**Description:** As a developer using the SDK, I want a subscription API so that I can receive live updates in my application with automatic decryption.

**Dependencies:** US-065

**Acceptance Criteria:**
- [ ] `client.from(table).on(event, callback).subscribe()` creates a realtime subscription
- [ ] Supported events: `'insert'`, `'update'`, `'delete'`, `'*'` (all)
- [ ] Callback receives `{ event, row }` where `row` is the full row data
- [ ] SDK automatically decrypts sensitive columns in `row` before invoking callback (same crypto path as `.select()`)
- [ ] For `delete` events, `row` contains only `{ id }` (no decryption needed)
- [ ] `subscription.unsubscribe()` sends unsubscribe message and closes
- [ ] WebSocket connection managed per client instance — shared across multiple subscriptions
- [ ] Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s max)
- [ ] On reconnect: resubscribe to all active subscriptions automatically
- [ ] Heartbeat monitoring: reconnect if no heartbeat received within 60s
- [ ] `{ data, error }` pattern on subscribe (error if connection fails)
- [ ] TypeScript types for subscription callback payload
- [ ] Unit tests pass (subscription lifecycle, reconnect logic, decryption in callbacks, unsubscribe)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-067: Dashboard MCP page
**Description:** As a developer, I want a Dashboard page for MCP so that I can see connection info and test MCP tools.

**Dependencies:** US-059

**Acceptance Criteria:**
- [ ] `/projects/:id/mcp` page (sidebar item activated, no longer grayed out)
- [ ] Shows MCP server connection info: stdio command, SSE URL, required env vars
- [ ] Copy-to-clipboard for MCP config JSON snippet (for Claude Code, Cursor, etc.)
- [ ] Lists available MCP tools with descriptions (from spec: schema, CRUD, auth, NL-query)
- [ ] "Test Tool" UI: select a tool, fill in parameters, execute, see results
- [ ] Test Tool uses the MCP server's HTTP/SSE endpoint for execution
- [ ] Unit tests pass (page renders, config snippet correct, tool list matches spec)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-068: Dashboard Realtime page
**Description:** As a developer, I want a Dashboard page for Realtime so that I can see active subscriptions and monitor events.

**Dependencies:** US-066

**Acceptance Criteria:**
- [ ] `/projects/:id/realtime` page (sidebar item activated, no longer grayed out)
- [ ] Shows active WebSocket connections count and subscription count
- [ ] Lists subscribed tables with event types and subscriber count
- [ ] Live event inspector: shows realtime events as they flow (connects via WebSocket from Dashboard)
- [ ] Event inspector shows: table, event type, row ID, timestamp
- [ ] Encrypted columns in event inspector show `[encrypted]` (Dashboard doesn't auto-decrypt in inspector)
- [ ] Unit tests pass (page renders, event list updates, connection stats display)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-069: Phase 3b E2E tests
**Description:** As the engineering team, we need end-to-end tests proving all Phase 3b capabilities work: MCP agent interaction, vector search, and realtime subscriptions with RLS.

**Dependencies:** US-059, US-062, US-066, US-067, US-068

**Acceptance Criteria:**
- [ ] Test setup: Docker Compose starts Postgres + Vault, FastAPI backend runs, MCP server available, SDK configured
- [ ] **Test 1 — MCP schema discovery:** Connect MCP client → `pqdb_list_tables` → returns correct tables → `pqdb_describe_table` → returns columns with sensitivity levels
- [ ] **Test 2 — MCP CRUD:** `pqdb_insert_rows` → `pqdb_query_rows` → results returned. Without encryption key: `[encrypted]`. With encryption key: plaintext
- [ ] **Test 3 — NL-to-query:** `pqdb_natural_language_query("find users where email is alice@example.com")` → correct blind index query → correct result
- [ ] **Test 4 — Vector search:** Create table with vector column → insert rows with embeddings → `client.from(table).similarTo('embedding', queryVector, { limit: 5 })` → top-5 results ordered by distance
- [ ] **Test 5 — Vector + encryption:** Table with vector column + searchable text column → `.similarTo()` → results include encrypted columns → SDK decrypts transparently
- [ ] **Test 6 — Realtime subscribe + receive:** Subscribe to table → insert row from another client → subscriber receives decrypted event within 5 seconds
- [ ] **Test 7 — Realtime RLS:** Two users with `owner` policy → User A subscribes → User B inserts a row → User A receives nothing (not their row). User A inserts a row → User A receives the event. Service role receives all events
- [ ] All 7 tests pass
- [ ] CI passes (tests run in CI with Docker Compose)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### Dependency Graph

```
US-056: MCP scaffolding              (Dependencies: None)
US-057: MCP schema tools             (Dependencies: US-056)
US-058: MCP CRUD tools               (Dependencies: US-057)
US-059: MCP auth + NL-query          (Dependencies: US-058)
US-060: Vector search backend        (Dependencies: None)           ← parallel with MCP chain
US-061: Vector index management      (Dependencies: US-060)
US-062: SDK vector search            (Dependencies: US-060)         ← parallel with US-061
US-063: Realtime triggers            (Dependencies: None)           ← parallel with MCP + Vector chains
US-064: Realtime WebSocket server    (Dependencies: US-063)
US-065: Realtime RLS enforcement     (Dependencies: US-064)
US-066: SDK realtime client          (Dependencies: US-065)
US-067: Dashboard MCP page           (Dependencies: US-059)
US-068: Dashboard Realtime page      (Dependencies: US-066)
US-069: Phase 3b E2E tests           (Dependencies: US-059, US-062, US-066, US-067, US-068)
```

### Parallel Execution Chains

```
Chain C (MCP):      US-056 → US-057 → US-058 → US-059 → US-067 (Dashboard MCP) ──┐
Chain D (Vector):   US-060 → US-061, US-062 (parallel) ─────────────────────────┤
Chain E (Realtime): US-063 → US-064 → US-065 → US-066 → US-068 (Dashboard RT) ─┤
                                                                                  └→ US-069 (E2E)
```

**Three independent starting chains** — MCP, Vector, and Realtime can begin in parallel.

**Note:** Phase 3b Dashboard stories (US-061, US-067, US-068) assume Phase 3a Dashboard is complete (US-043 through US-048). Phase 3b ships after Phase 3a.

**Critical path:** US-063 → US-064 → US-065 → US-066 → US-068 → US-069 (Realtime is the longest chain)

## Functional Requirements

- **FR-1:** MCP server is a standalone TypeScript process in `/mcp` importing `@pqdb/client`
- **FR-2:** MCP supports stdio + SSE transports
- **FR-3:** MCP tools: `pqdb_list_tables`, `pqdb_describe_table`, `pqdb_describe_schema`, `pqdb_query_rows`, `pqdb_insert_rows`, `pqdb_update_rows`, `pqdb_delete_rows`, `pqdb_list_users`, `pqdb_list_roles`, `pqdb_list_policies`, `pqdb_natural_language_query`
- **FR-4:** MCP resources: `pqdb://tables`, `pqdb://tables/{name}`, `pqdb://tables/{name}/stats`
- **FR-5:** NL-to-query is rule-based pattern matching, not LLM-powered
- **FR-6:** Vector search via `similar_to` field on select endpoint, with cosine/L2/inner_product metrics
- **FR-7:** Vector columns must be `plain` — encrypted vectors rejected at schema time
- **FR-8:** Vector indexes: HNSW and IVFFlat creation/deletion endpoints
- **FR-9:** Realtime via PostgreSQL LISTEN/NOTIFY + WebSocket embedded in FastAPI
- **FR-10:** Trigger sends only `{table, event, pk}` — realtime server fetches full row
- **FR-11:** RLS enforcement per-event, per-subscriber before delivery
- **FR-12:** SDK `.similarTo()` and `.on().subscribe()` methods with TypeScript types
- **FR-13:** SDK auto-decrypts sensitive columns in both vector search results and realtime events
- **FR-14:** Dashboard MCP page with connection config and test tool UI
- **FR-15:** Dashboard Realtime page with live event inspector

## Non-Goals (Phase 3b)

- **LLM-powered NL-to-query** — Rule-based V1 is sufficient; LLM integration can be added later
- **Logical replication** — LISTEN/NOTIFY is sufficient for Phase 3 scale; swap in Phase 4 if needed
- **Approximate nearest neighbor guarantees** — pgvector handles this; we expose the API
- **Custom distance functions** — Only cosine, L2, inner product (pgvector built-ins)
- **Realtime filtering by column** — Subscribers get full rows, not column subsets
- **MCP prompts** — Only tools and resources in V1; prompts can be added later

## Technical Considerations

- **MCP server:** TypeScript 5.x in `/mcp`. Dependencies: `@modelcontextprotocol/sdk`, `@pqdb/client` (workspace link). Build with `tsup`. CLI entry point: `pqdb-mcp`.
- **Backend (Vector):** Extend `crud.py` select handler with `similar_to` support. New `indexes.py` route file. Extend schema validation to reject encrypted vectors.
- **Backend (Realtime):** New `realtime.py` WebSocket handler using Starlette. New `triggers.py` service for trigger management. Reuses existing RLS enforcement logic from `crud.py`.
- **SDK (Vector):** New `.similarTo()` method on query builder in `builder.ts`. New types in `types.ts`.
- **SDK (Realtime):** New `src/client/realtime.ts` module. WebSocket client with reconnect logic. Integrates with existing crypto transform for decryption.
- **Dashboard:** Two new pages in existing TanStack Start app. MCP page is read-only display + test form. Realtime page connects via WebSocket for live event display.
- **Testing:** MCP tests use `@modelcontextprotocol/sdk` test client. Vector tests need real Postgres with pgvector. Realtime tests need WebSocket client + concurrent inserts.

## Success Metrics

- **SM-1:** MCP E2E: connect → list_tables → query_rows → results (ciphertext without key, plaintext with key)
- **SM-2:** NL-to-query: "find users where email is X" → correct blind index query → correct result
- **SM-3:** Vector E2E: insert embeddings → `.similarTo()` → correct top-K by distance
- **SM-4:** Realtime E2E: subscribe → insert from another client → event received < 5 seconds
- **SM-5:** Realtime RLS: owner-policy subscriber only receives own rows; service role receives all
- **SM-6:** All 14 stories have passing tests in CI
- **SM-7:** TypeScript MCP server and SDK compile with strict mode, zero type errors
- **SM-8:** Backend passes mypy strict type checking

## Open Questions

- **OQ-1:** Should the MCP server support batch operations (insert 100 rows in one tool call) or limit to single-row operations? Batch is more useful for AI agents but increases complexity. Current design: arrays supported in `pqdb_insert_rows`.
- **OQ-2:** For realtime, should we support filtered subscriptions (e.g., "only INSERT events where status = 'active'")? This would reduce traffic but requires server-side filter evaluation. Current design: subscribe to all events for a table, client-side filtering.
- **OQ-3:** Should the NL-to-query tool return the generated query in addition to results, for transparency? This would help developers understand what the agent is doing. Current design: returns results only.
