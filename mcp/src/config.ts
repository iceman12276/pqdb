/**
 * Configuration types and parsing for the pqdb MCP server.
 */

export type Transport = "stdio" | "sse" | "http";

/** Expected length (bytes) of an ML-KEM-768 private (secret) key (FIPS 203). */
export const ML_KEM_768_SECRET_KEY_BYTES = 2400;

export interface ServerConfig {
  /** Base URL of the pqdb API server. */
  projectUrl: string;
  /** Transport type: stdio (default), sse, or http (OAuth + StreamableHTTP). */
  transport: Transport;
  /** Port for SSE/HTTP transport (default 3001, or 3002 for http). */
  port: number;
  /** API key for authenticating with pqdb (optional for http transport). */
  apiKey: string;
  /** Optional encryption key for client-side decryption. */
  encryptionKey: string | undefined;
  /** Optional developer JWT for project management endpoints. */
  devToken: string | undefined;
  /** Optional project ID resolved during OAuth (for JWT auth on /v1/db/* endpoints). */
  projectId: string | undefined;
  /**
   * Optional ML-KEM-768 private key (2400 bytes) decoded from the
   * PQDB_PRIVATE_KEY environment variable. When set, the MCP server
   * wraps per-project encryption keys using the developer's public
   * key and unwraps them on project selection.
   */
  privateKey: Uint8Array | undefined;
}

export interface ParsedArgs {
  projectUrl: string | undefined;
  transport: Transport;
  port: number;
}

/**
 * Parse CLI arguments from argv.
 * Supports: --project-url <url> --transport <stdio|sse> --port <number>
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let projectUrl: string | undefined;
  let transport: Transport = "stdio";
  let port = 3001;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project-url" && i + 1 < argv.length) {
      projectUrl = argv[++i];
    } else if (arg === "--transport" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val !== "stdio" && val !== "sse" && val !== "http") {
        throw new Error(`Invalid transport: ${val}. Must be "stdio", "sse", or "http".`);
      }
      transport = val;
    } else if (arg === "--port" && i + 1 < argv.length) {
      port = parseInt(argv[++i], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${argv[i]}. Must be 1-65535.`);
      }
    }
  }

  return { projectUrl, transport, port };
}

/**
 * Decode a base64 or base64url encoded string to bytes, normalizing
 * base64url (- _) into standard base64 (+ /) and re-padding.
 *
 * Throws if the string contains characters that are not valid in
 * either encoding, or if the length is not a multiple of 4 after padding.
 */
function decodeBase64Flexible(input: string): Uint8Array {
  // Strip whitespace
  const trimmed = input.replace(/\s+/g, "");
  // Reject characters that are not valid in base64 or base64url
  if (!/^[A-Za-z0-9+/_=-]*$/.test(trimmed)) {
    throw new Error(
      "PQDB_PRIVATE_KEY contains characters that are not valid base64 or base64url.",
    );
  }
  // Normalize base64url -> base64 and re-pad
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + "=".repeat(4 - (normalized.length % 4));
  const buf = Buffer.from(padded, "base64");
  // Round-trip check: re-encoding must match the padded input (minus trailing padding).
  // This catches strings like "!!!" that slip through the character regex by accident.
  const reEncoded = buf.toString("base64");
  if (
    reEncoded.replace(/=+$/, "") !== padded.replace(/=+$/, "") &&
    reEncoded !== padded
  ) {
    throw new Error("PQDB_PRIVATE_KEY failed base64 round-trip decoding.");
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Parse and validate PQDB_PRIVATE_KEY.
 *
 * Accepts base64 or base64url encoding. Decoded length MUST match
 * ML_KEM_768_SECRET_KEY_BYTES (2400). Fails fast with a clear error
 * on any mismatch so misconfiguration cannot silently create broken
 * encrypted projects.
 */
export function parsePrivateKey(raw: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Flexible(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PQDB_PRIVATE_KEY is not valid base64/base64url: ${msg}`,
    );
  }
  if (decoded.length !== ML_KEM_768_SECRET_KEY_BYTES) {
    throw new Error(
      `PQDB_PRIVATE_KEY has wrong length: expected ${ML_KEM_768_SECRET_KEY_BYTES} bytes (ML-KEM-768 secret key), got ${decoded.length}.`,
    );
  }
  return decoded;
}

/**
 * Build a complete ServerConfig from CLI args + environment variables.
 */
export function buildConfig(args: ParsedArgs): ServerConfig {
  const apiKey = process.env.PQDB_API_KEY ?? "";
  // API key is required for stdio/sse (pre-configured), optional for http (OAuth provides auth)
  if (!apiKey && args.transport !== "http") {
    throw new Error("PQDB_API_KEY environment variable is required.");
  }

  const projectUrl = args.projectUrl ?? process.env.PQDB_PROJECT_URL;
  if (!projectUrl) {
    throw new Error(
      "Project URL is required. Pass --project-url <url> or set PQDB_PROJECT_URL.",
    );
  }

  const rawPrivateKey = process.env.PQDB_PRIVATE_KEY;
  const privateKey =
    rawPrivateKey && rawPrivateKey.length > 0
      ? parsePrivateKey(rawPrivateKey)
      : undefined;

  return {
    projectUrl,
    transport: args.transport,
    port: args.port,
    apiKey,
    encryptionKey: process.env.PQDB_ENCRYPTION_KEY || undefined,
    devToken: process.env.PQDB_DEV_TOKEN || undefined,
    projectId: undefined,
    privateKey,
  };
}
