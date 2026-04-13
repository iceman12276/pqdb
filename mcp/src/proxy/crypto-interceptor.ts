/**
 * Crypto interceptor for the pqdb MCP proxy (US-012).
 *
 * Intercepts crypto-relevant tool calls, encrypts data before forwarding
 * to the hosted MCP server, and decrypts responses before returning to
 * Claude Code. Reuses all crypto functions from @pqdb/client.
 */
import {
  deriveKeyPair,
  transformInsertRows,
  transformSelectResponse,
  transformFilters,
  encapsulate,
  decapsulate,
  defineTableSchema,
  ColumnDef,
} from "@pqdb/client";
import type { KeyPair, TableSchema, FilterClause } from "@pqdb/client";

/** The 7 tool names that require crypto interception. */
const CRYPTO_TOOLS = new Set([
  "pqdb_insert_rows",
  "pqdb_query_rows",
  "pqdb_update_rows",
  "pqdb_delete_rows",
  "pqdb_create_project",
  "pqdb_select_project",
  "pqdb_natural_language_query",
]);

/** Check whether a tool name requires crypto interception. */
export function isCryptoTool(name: string): boolean {
  return CRYPTO_TOOLS.has(name);
}

/** Column info from introspection endpoint. */
interface IntrospectColumn {
  name: string;
  type: string;
  sensitivity: "plain" | "searchable" | "private";
}

interface IntrospectTable {
  name: string;
  columns: IntrospectColumn[];
}

/** Tool call result shape (matches upstream-client.ts CallToolResult). */
interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Configuration for CryptoInterceptor. */
export interface CryptoInterceptorConfig {
  privateKey: Uint8Array;
  backendUrl: string;
  authToken: string;
}

/** Convert hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Encode Uint8Array to standard base64. */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode standard base64 to Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Encode bytes to base64url without padding (for deriveKeyPair). */
function bytesToBase64UrlNoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * CryptoInterceptor — standalone class that intercepts MCP tool calls,
 * encrypts outgoing data and decrypts incoming responses using @pqdb/client
 * crypto functions.
 */
export class CryptoInterceptor {
  private readonly privateKey: Uint8Array;
  private readonly backendUrl: string;
  private readonly authToken: string;

  private sharedSecret: Uint8Array | null = null;
  private pendingSharedSecret: Uint8Array | null = null;
  /**
   * Currently selected project ID. Captured when the client calls
   * pqdb_select_project or pqdb_create_project, and attached as the
   * `x-project-id` header on all direct backend fetches (HMAC key,
   * schema introspection). The backend's developer-JWT auth path
   * requires this header alongside `Authorization: Bearer`.
   */
  private currentProjectId: string | null = null;

  /** Schema cache with 60s TTL. */
  private readonly schemaCache = new Map<
    string,
    { schema: TableSchema; timestamp: number }
  >();
  private readonly SCHEMA_TTL = 60_000;

  constructor(config: CryptoInterceptorConfig) {
    this.privateKey = config.privateKey;
    this.backendUrl = config.backendUrl;
    this.authToken = config.authToken;
  }

  /** Whether a shared secret is currently available for CRUD encryption. */
  hasSharedSecret(): boolean {
    return this.sharedSecret !== null;
  }

  /** Manually set the shared secret (e.g. for testing or external setup). */
  setSharedSecret(secret: Uint8Array): void {
    this.sharedSecret = secret;
  }

  /**
   * Transform tool arguments before forwarding to the upstream MCP server.
   * Encrypts data for crypto-relevant tools; passes through unchanged for others.
   */
  async transformRequest(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isCryptoTool(toolName)) {
      return args;
    }

    switch (toolName) {
      case "pqdb_insert_rows":
        return this.transformInsertRequest(args);
      case "pqdb_query_rows":
        return this.transformQueryRequest(args);
      case "pqdb_update_rows":
        return this.transformUpdateRequest(args);
      case "pqdb_delete_rows":
        return this.transformDeleteRequest(args);
      case "pqdb_create_project":
        return this.transformCreateProjectRequest(args);
      case "pqdb_select_project":
        // Capture the target project_id so subsequent direct backend fetches
        // (HMAC key, schema introspection) can send the required x-project-id
        // header. The call itself passes through unchanged; the wrapped key is
        // decapsulated on the response.
        if (typeof args.project_id === "string") {
          this.currentProjectId = args.project_id;
        }
        return args;
      case "pqdb_natural_language_query":
        // NL query: args pass through unchanged; decryption happens on response
        return args;
      default:
        return args;
    }
  }

  /**
   * Transform tool response before returning to the caller.
   * Decrypts data for crypto-relevant tools; passes through unchanged for others.
   */
  async transformResponse(
    toolName: string,
    result: ToolResult,
    metadata: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!isCryptoTool(toolName)) {
      return result;
    }

    switch (toolName) {
      case "pqdb_query_rows":
        return this.transformQueryResponse(result, metadata);
      case "pqdb_select_project":
        return this.transformSelectProjectResponse(result);
      case "pqdb_create_project":
        return this.transformCreateProjectResponse(result);
      case "pqdb_natural_language_query":
        return this.transformNlQueryResponse(result);
      default:
        return result;
    }
  }

  // ── Private: request transforms ─────────────────────────────────────

  private async transformInsertRequest(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.sharedSecret) return args;

    const table = args.table as string;
    const rows = args.rows as Record<string, unknown>[];

    const { keyPair, hmacKey, schema } = await this.getCryptoContext(table);

    if (!this.tableHasEncryptedColumns(schema)) {
      return args;
    }

    const transformedRows = await transformInsertRows(rows, schema, keyPair, hmacKey);
    return { ...args, rows: transformedRows };
  }

  private async transformQueryRequest(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.sharedSecret) return args;

    const table = args.table as string;
    const filters = args.filters as FilterClause[] | undefined;

    if (!filters || filters.length === 0) {
      // No filters to transform — schema fetch needed only for response decryption
      return args;
    }

    const { hmacKey, schema } = await this.getCryptoContext(table);

    if (!this.tableHasEncryptedColumns(schema)) {
      return args;
    }

    const transformedFilters = transformFilters(filters, schema, hmacKey);
    return { ...args, filters: transformedFilters };
  }

  private async transformUpdateRequest(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.sharedSecret) return args;

    const table = args.table as string;
    const values = args.values as Record<string, unknown>;
    const filters = args.filters as FilterClause[] | undefined;

    const { keyPair, hmacKey, schema } = await this.getCryptoContext(table);

    if (!this.tableHasEncryptedColumns(schema)) {
      return args;
    }

    // transformInsertRows works for updates too — wrap as single-row array, unwrap
    const [transformedValues] = await transformInsertRows(
      [values],
      schema,
      keyPair,
      hmacKey,
    );

    let transformedFilters = filters ?? [];
    if (transformedFilters.length > 0) {
      transformedFilters = transformFilters(transformedFilters, schema, hmacKey);
    }

    return { ...args, values: transformedValues, filters: transformedFilters };
  }

  private async transformDeleteRequest(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.sharedSecret) return args;

    const table = args.table as string;
    const filters = args.filters as FilterClause[] | undefined;

    if (!filters || filters.length === 0) {
      return args;
    }

    const { hmacKey, schema } = await this.getCryptoContext(table);

    if (!this.tableHasEncryptedColumns(schema)) {
      return args;
    }

    const transformedFilters = transformFilters(filters, schema, hmacKey);
    return { ...args, filters: transformedFilters };
  }

  private async transformCreateProjectRequest(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Fetch the developer's ML-KEM public key
    const pkResp = await this.fetchJson<{ public_key: string | null }>(
      "/v1/auth/me/public-key",
    );

    if (!pkResp.public_key) {
      // No public key on file — pass through without encryption
      return args;
    }

    const publicKey = base64ToBytes(pkResp.public_key);
    const { ciphertext, sharedSecret } = await encapsulate(publicKey);

    // Store the pending secret — will be committed on successful response
    this.pendingSharedSecret = sharedSecret;

    return {
      ...args,
      wrapped_encryption_key: bytesToBase64(ciphertext),
    };
  }

  // ── Private: response transforms ────────────────────────────────────

  private async transformQueryResponse(
    result: ToolResult,
    metadata: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!this.sharedSecret) return result;

    const parsed = this.parseResponseContent(result);
    if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) {
      return result;
    }

    // Determine table name from metadata or from the original args
    const table = metadata.table as string | undefined;
    if (!table) return result;

    const { keyPair, schema } = await this.getDecryptionContext(table);

    if (!this.tableHasEncryptedColumns(schema)) {
      return result;
    }

    const decryptedData = await transformSelectResponse(
      parsed.data,
      schema,
      keyPair.secretKey,
    );

    return this.replaceResponseData(result, { ...parsed, data: decryptedData });
  }

  private async transformSelectProjectResponse(
    result: ToolResult,
  ): Promise<ToolResult> {
    const parsed = this.parseResponseContent(result);
    if (!parsed || !parsed.data) return result;

    const data = parsed.data as Record<string, unknown>;
    const project = (data.project ?? data) as Record<string, unknown>;
    const wrappedKey = project?.wrapped_encryption_key;

    // Capture the project ID from the authoritative response so the
    // interceptor's direct backend fetches know which project to target.
    // Prefer project.id (nested) then data.active_project_id (top-level).
    const responseProjectId =
      (typeof project?.id === "string" ? project.id : undefined) ??
      (typeof data.active_project_id === "string"
        ? (data.active_project_id as string)
        : undefined);
    if (responseProjectId) {
      this.currentProjectId = responseProjectId;
    }

    if (!wrappedKey || typeof wrappedKey !== "string") {
      // No wrapped key — project doesn't use encryption
      return result;
    }

    const wrapped = base64ToBytes(wrappedKey);
    const sharedSecret = await decapsulate(wrapped, this.privateKey);
    this.sharedSecret = sharedSecret;

    // Update the response to reflect encryption is now active
    const updatedData = { ...parsed.data, encryption_active: true };
    return this.replaceResponseData(result, { ...parsed, data: updatedData });
  }

  private async transformCreateProjectResponse(
    result: ToolResult,
  ): Promise<ToolResult> {
    // Only commit the pending shared secret if the response is successful
    if (result.isError || !this.pendingSharedSecret) {
      this.pendingSharedSecret = null;
      return result;
    }

    const parsed = this.parseResponseContent(result);
    if (!parsed || parsed.error) {
      this.pendingSharedSecret = null;
      return result;
    }

    this.sharedSecret = this.pendingSharedSecret;
    this.pendingSharedSecret = null;

    // Capture the newly-created project ID so subsequent direct backend
    // fetches (HMAC key, schema introspection) can attach x-project-id.
    const data = parsed.data as Record<string, unknown> | undefined;
    const project = data?.project as Record<string, unknown> | undefined;
    if (project && typeof project.id === "string") {
      this.currentProjectId = project.id;
    }

    return result;
  }

  private async transformNlQueryResponse(
    result: ToolResult,
  ): Promise<ToolResult> {
    if (!this.sharedSecret) return result;

    const parsed = this.parseResponseContent(result);
    if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) {
      return result;
    }

    // NL query responses include translated_query with the table name
    const translatedQuery = parsed.translated_query as Record<string, unknown> | undefined;
    const table = translatedQuery?.table as string | undefined;
    if (!table) return result;

    const { keyPair, schema } = await this.getDecryptionContext(table);

    if (!this.tableHasEncryptedColumns(schema)) {
      return result;
    }

    const decryptedData = await transformSelectResponse(
      parsed.data,
      schema,
      keyPair.secretKey,
    );

    return this.replaceResponseData(result, { ...parsed, data: decryptedData });
  }

  // ── Private: crypto context helpers ─────────────────────────────────

  /**
   * Get the full crypto context for a table: key pair, HMAC key, and schema.
   * Used by request transforms that need encryption + blind indexing.
   */
  private async getCryptoContext(tableName: string): Promise<{
    keyPair: KeyPair;
    hmacKey: Uint8Array;
    schema: TableSchema;
  }> {
    const keyPair = await this.deriveCurrentKeyPair();
    const schema = await this.getTableSchema(tableName);
    const hmacKey = await this.fetchHmacKey();

    return { keyPair, hmacKey, schema };
  }

  /**
   * Get decryption context: key pair and schema only (no HMAC key needed).
   * Used by response transforms that only need to decrypt.
   */
  private async getDecryptionContext(tableName: string): Promise<{
    keyPair: KeyPair;
    schema: TableSchema;
  }> {
    const keyPair = await this.deriveCurrentKeyPair();
    const schema = await this.getTableSchema(tableName);
    return { keyPair, schema };
  }

  /** Derive a key pair from the current shared secret. */
  private async deriveCurrentKeyPair(): Promise<KeyPair> {
    if (!this.sharedSecret) {
      throw new Error("No shared secret available for key derivation");
    }
    const keyString = bytesToBase64UrlNoPad(this.sharedSecret);
    return deriveKeyPair(keyString);
  }

  /** Fetch the HMAC key from the backend. */
  private async fetchHmacKey(): Promise<Uint8Array> {
    const resp = await this.fetchJson<{
      current_version: number;
      keys: Record<string, string>;
    }>("/v1/db/hmac-key");

    const currentKey = resp.keys[String(resp.current_version)];
    return hexToBytes(currentKey);
  }

  /** Fetch and cache table schema from introspection endpoint. */
  private async getTableSchema(tableName: string): Promise<TableSchema> {
    const cached = this.schemaCache.get(tableName);
    if (cached && Date.now() - cached.timestamp < this.SCHEMA_TTL) {
      return cached.schema;
    }

    const introspect = await this.fetchJson<{ tables: IntrospectTable[] }>(
      "/v1/db/introspect",
    );

    const tableData = introspect.tables.find((t) => t.name === tableName);
    if (!tableData) {
      throw new Error(`Table "${tableName}" not found in schema`);
    }

    const schema = this.buildTableSchema(tableName, tableData.columns);
    this.schemaCache.set(tableName, { schema, timestamp: Date.now() });
    return schema;
  }

  /** Build a TableSchema from introspection column data. */
  private buildTableSchema(
    tableName: string,
    columns: IntrospectColumn[],
  ): TableSchema {
    const schemaCols: Record<string, ColumnDef> = {};
    for (const col of columns) {
      schemaCols[col.name] = new ColumnDef(col.type as "text", col.sensitivity);
    }
    return defineTableSchema(tableName, schemaCols);
  }

  /** Check if a table schema has any encrypted columns. */
  private tableHasEncryptedColumns(schema: TableSchema): boolean {
    return Object.values(schema.columns).some((col) => {
      const c = col as { sensitivity: string };
      return c.sensitivity === "searchable" || c.sensitivity === "private";
    });
  }

  // ── Private: HTTP + response helpers ────────────────────────────────

  /** Fetch JSON from the backend with auth. */
  private async fetchJson<T>(path: string): Promise<T> {
    // Developer-JWT auth requires both Authorization and x-project-id when
    // hitting project-scoped endpoints. /v1/auth/me/public-key is the only
    // non-project-scoped endpoint we call, and it ignores extra headers —
    // so sending x-project-id when known is always safe.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
    };
    if (this.currentProjectId) {
      headers["x-project-id"] = this.currentProjectId;
    }
    const response = await fetch(`${this.backendUrl}${path}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      let detail: string;
      try {
        const body = (await response.json()) as { detail?: unknown };
        detail =
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail);
      } catch {
        detail = response.statusText;
      }
      throw new Error(detail);
    }

    return (await response.json()) as T;
  }

  /** Parse the first text content from a tool result as JSON. */
  private parseResponseContent(
    result: ToolResult,
  ): Record<string, unknown> | null {
    const textContent = result.content.find((c) => c.type === "text");
    if (!textContent?.text) return null;

    try {
      return JSON.parse(textContent.text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Replace the data in a tool result's text content. */
  private replaceResponseData(
    result: ToolResult,
    newData: Record<string, unknown>,
  ): ToolResult {
    return {
      ...result,
      content: result.content.map((c) => {
        if (c.type === "text") {
          return { ...c, text: JSON.stringify(newData) };
        }
        return c;
      }),
    };
  }
}
