/**
 * @pqdb/mcp — MCP server for pqdb
 *
 * Allows AI agents to connect to pqdb projects via the Model Context Protocol.
 */

export { createPqdbMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
export type { PqdbMcpServer } from "./server.js";
export { parseArgs, buildConfig } from "./config.js";
export type { ServerConfig, Transport, ParsedArgs } from "./config.js";
export { registerSchemaTools } from "./schema-tools.js";
