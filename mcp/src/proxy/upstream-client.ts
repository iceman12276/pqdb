/**
 * UpstreamClient — connects to a hosted MCP server as an MCP client.
 *
 * US-011: Upstream MCP client for the crypto proxy.
 * Forwards tool calls to the hosted server and returns responses.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Simplified tool descriptor returned by listTools(). */
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** Result returned by callTool(). */
export interface CallToolResult {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  [key: string]: unknown;
}

export class UpstreamClient {
  private readonly targetUrl: string;
  private readonly authHeaders?: Record<string, string>;
  private client: Client | null = null;

  constructor(targetUrl: string, authHeaders?: Record<string, string>) {
    this.targetUrl = targetUrl;
    this.authHeaders = authHeaders;
  }

  /**
   * Establishes a StreamableHTTPClientTransport connection to the hosted MCP server.
   */
  async connect(): Promise<void> {
    const url = new URL(this.targetUrl);

    const transportOpts = this.authHeaders
      ? { requestInit: { headers: this.authHeaders } }
      : undefined;

    const transport = new StreamableHTTPClientTransport(url, transportOpts);

    const client = new Client(
      { name: "pqdb-proxy", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      const code =
        err !== null &&
        typeof err === "object" &&
        "code" in err
          ? (err as Record<string, unknown>).code
          : undefined;

      if (name === "AbortError" || message.includes("aborted")) {
        throw new Error(
          `Connection timed out to upstream MCP server at ${this.targetUrl}: ${message}`,
        );
      }

      if (
        code === 401 ||
        code === 403 ||
        /unauthori|forbidden/i.test(message)
      ) {
        throw new Error(
          `Auth failed for upstream MCP server at ${this.targetUrl}: ${message}`,
        );
      }

      throw new Error(
        `Failed to connect to upstream MCP server at ${this.targetUrl}: ${message}`,
      );
    }

    this.client = client;
  }

  /**
   * Returns all tools from the hosted MCP server with their names,
   * descriptions, and input schemas.
   */
  async listTools(): Promise<ToolInfo[]> {
    if (!this.client) {
      throw new Error("Not connected — call connect() first");
    }

    const result = await this.client.listTools();

    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Forwards a tool call to the hosted MCP server and returns the result.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error("Not connected — call connect() first");
    }

    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    return result as CallToolResult;
  }

  /**
   * Cleanly disconnects from the hosted MCP server.
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
