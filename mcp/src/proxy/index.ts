/**
 * Proxy module barrel exports.
 *
 * Re-exports all public types and functions from the proxy sub-modules.
 */
export { createCryptoProxyServer } from "./proxy-server.js";
export type { ProxyConfig } from "./proxy-server.js";
export { CryptoInterceptor, isCryptoTool } from "./crypto-interceptor.js";
export type { CryptoInterceptorConfig } from "./crypto-interceptor.js";
export { UpstreamClient } from "./upstream-client.js";
export type { ToolInfo, CallToolResult } from "./upstream-client.js";
export { discoverRecoveryFile, loadPrivateKeyFromRecovery } from "./recovery.js";
export { proxyLogin } from "./proxy-auth.js";
export type { ProxyAuthResult, ProxyLoginOptions } from "./proxy-auth.js";
