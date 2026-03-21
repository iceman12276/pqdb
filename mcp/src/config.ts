/**
 * Configuration types and parsing for the pqdb MCP server.
 */

export type Transport = "stdio" | "sse" | "http";

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

  return {
    projectUrl,
    transport: args.transport,
    port: args.port,
    apiKey,
    encryptionKey: process.env.PQDB_ENCRYPTION_KEY || undefined,
    devToken: process.env.PQDB_DEV_TOKEN || undefined,
  };
}
