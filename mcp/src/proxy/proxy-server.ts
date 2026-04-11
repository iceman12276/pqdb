/**
 * Crypto proxy server assembly (US-013).
 *
 * Combines UpstreamClient and CryptoInterceptor into a functioning MCP server
 * that dynamically registers all tools from the hosted MCP. Crypto-relevant
 * tools are transparently intercepted for client-side encryption/decryption.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { UpstreamClient } from "./upstream-client.js";
import type { CallToolResult } from "./upstream-client.js";
import { CryptoInterceptor, isCryptoTool } from "./crypto-interceptor.js";

/** Configuration for the crypto proxy server. */
export interface ProxyConfig {
  /** URL of the hosted MCP server to proxy. */
  targetUrl: string;
  /** ML-KEM-768 private key from the developer's recovery file. */
  privateKey: Uint8Array;
  /** Backend API URL for schema introspection and HMAC key retrieval. */
  backendUrl: string;
  /** JWT token for backend authentication. */
  authToken: string;
}

/**
 * Create a crypto proxy MCP server that connects to a hosted MCP,
 * discovers all tools, and re-exposes them with transparent encryption.
 *
 * For crypto-relevant tools: transformRequest → upstream.callTool → transformResponse
 * For non-crypto tools: upstream.callTool → return result as-is
 */
export async function createCryptoProxyServer(config: ProxyConfig): Promise<{
  mcpServer: McpServer;
  upstream: UpstreamClient;
}> {
  // 1. Connect to the hosted MCP server
  const upstream = new UpstreamClient(config.targetUrl);
  await upstream.connect();

  // 2. Discover all available tools
  const tools = await upstream.listTools();

  // 3. Create the local MCP server
  const mcpServer = new McpServer(
    { name: "pqdb-crypto-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // 4. Create the crypto interceptor
  const interceptor = new CryptoInterceptor({
    privateKey: config.privateKey,
    backendUrl: config.backendUrl,
    authToken: config.authToken,
  });

  // 5. Register each upstream tool on the local server
  for (const tool of tools) {
    // Use a permissive schema — the hosted MCP server validates inputs.
    // z.object({}).passthrough() accepts any object without stripping properties.
    const permissiveSchema = z.object({}).passthrough();

    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: permissiveSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          // Transform request (encrypts for crypto tools, passes through for others)
          const transformedArgs = await interceptor.transformRequest(
            tool.name,
            args,
          );

          // Forward to upstream
          const result = await upstream.callTool(tool.name, transformedArgs);

          // Transform response (decrypts for crypto tools, passes through for others)
          const transformedResult = await interceptor.transformResponse(
            tool.name,
            result,
            args,
          );

          return transformedResult as {
            content: Array<{ type: "text"; text: string }>;
            isError?: boolean;
          };
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }
      },
    );
  }

  return { mcpServer, upstream };
}
