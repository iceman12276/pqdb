/**
 * @pqdb/mcp — MCP server for pqdb
 *
 * Allows AI agents to connect to pqdb projects via the Model Context Protocol.
 */

export { createPqdbMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
export type { PqdbMcpServer } from "./server.js";
export { parseArgs, buildConfig } from "./config.js";
export type { ServerConfig, Transport, Mode, ParsedArgs } from "./config.js";
export { registerSchemaTools } from "./schema-tools.js";
export { registerCrudTools } from "./crud-tools.js";
export { registerAuthTools } from "./auth-tools.js";
export { registerNlQueryTool, translateNaturalLanguage } from "./nl-query.js";
export type { SchemaInfo, ColumnInfo, TranslationResult } from "./nl-query.js";
export { registerProjectTools } from "./project-tools.js";
export { registerAdminTools } from "./admin-tools.js";
export { registerDocsTools, searchDocs, generateTypeScript } from "./docs-tools.js";
