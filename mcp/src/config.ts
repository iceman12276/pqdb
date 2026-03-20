/**
 * Configuration types and parsing for the pqdb MCP server.
 */

export type Transport = "stdio" | "sse";

export interface ServerConfig {
  /** Base URL of the pqdb API server. */
  projectUrl: string;
  /** Transport type: stdio (default) or sse. */
  transport: Transport;
  /** Port for SSE transport (default 3001). */
  port: number;
  /** API key for authenticating with pqdb. */
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
      if (val !== "stdio" && val !== "sse") {
        throw new Error(`Invalid transport: ${val}. Must be "stdio" or "sse".`);
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
  const apiKey = process.env.PQDB_API_KEY;
  if (!apiKey) {
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
