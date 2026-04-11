/**
 * Unit tests for US-016: Wire OAuth into proxy startup.
 *
 * Verifies that proxy mode in cli.ts:
 * - Requires PQDB_DASHBOARD_URL environment variable
 * - Calls proxyLogin() before createCryptoProxyServer()
 * - Populates ProxyConfig.authToken with the JWT from proxyLogin()
 * - Logs the expected connection message
 * - Exits with a clear error if login times out
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock proxyLogin to return a fake JWT
const mockProxyLogin = vi.fn<
  (dashboardUrl: string) => Promise<{ devJwt: string; refreshToken?: string; encryptionKey?: string }>
>();

// Mock createCryptoProxyServer to return a fake MCP server
const mockMcpConnect = vi.fn<() => Promise<void>>();
const mockCreateCryptoProxyServer = vi.fn();

// Mock recovery file helpers
const mockDiscoverRecoveryFile = vi.fn<(explicit?: string) => string>();
const mockLoadPrivateKeyFromRecovery = vi.fn<(path: string) => Uint8Array>();

// Mock StdioServerTransport
const mockStdioTransportInstance = { sessionId: "test" };
const MockStdioServerTransport = vi.fn(() => mockStdioTransportInstance);

vi.mock("../../src/proxy/index.js", () => ({
  proxyLogin: (...args: unknown[]) => mockProxyLogin(...(args as [string])),
  discoverRecoveryFile: (...args: unknown[]) => mockDiscoverRecoveryFile(...(args as [string?])),
  loadPrivateKeyFromRecovery: (...args: unknown[]) => mockLoadPrivateKeyFromRecovery(...(args as [string])),
  createCryptoProxyServer: (...args: unknown[]) => mockCreateCryptoProxyServer(...args),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: MockStdioServerTransport,
}));

// Mock the other imports that cli.ts uses but we don't need
vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: vi.fn(),
}));

vi.mock("express", () => ({
  default: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    listen: vi.fn(),
  })),
}));

vi.mock("../../src/server.js", () => ({
  createPqdbMcpServer: vi.fn(),
}));

vi.mock("../../src/http-app.js", () => ({
  createMcpHttpApp: vi.fn(),
}));

describe("CLI proxy mode OAuth wiring (US-016)", () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  let callOrder: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    callOrder = [];

    // Default mock implementations
    mockDiscoverRecoveryFile.mockReturnValue("/fake/recovery.json");
    mockLoadPrivateKeyFromRecovery.mockReturnValue(new Uint8Array(2400));

    mockProxyLogin.mockImplementation(async () => {
      callOrder.push("proxyLogin");
      return { devJwt: "test-jwt-token-from-oauth" };
    });

    mockCreateCryptoProxyServer.mockImplementation(async () => {
      callOrder.push("createCryptoProxyServer");
      return {
        mcpServer: { connect: mockMcpConnect },
        upstream: {},
      };
    });

    mockMcpConnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  /**
   * Helper to import and run main() with proxy mode args.
   * Uses dynamic import to pick up fresh mocks each time.
   */
  async function runProxyMode(extraEnv?: Record<string, string>): Promise<void> {
    if (extraEnv) {
      Object.assign(process.env, extraEnv);
    }
    process.argv = [
      "node",
      "cli.js",
      "--mode", "proxy",
      "--target", "http://localhost:3002/mcp",
      "--project-url", "http://localhost:8000",
    ];

    // Re-import cli.ts to trigger main()
    // We need to import the module fresh each time
    const mod = await import("../../src/cli.js");
  }

  it("requires PQDB_DASHBOARD_URL when running in proxy mode", async () => {
    delete process.env.PQDB_DASHBOARD_URL;

    // Since cli.ts calls main() at module level, we need to test the error
    // We'll test the logic by extracting it — but for now, test via the
    // config + the new validation in proxy mode.
    //
    // Actually, the simpler approach: test the proxy startup function directly.
    // Let's import the pieces and test the wiring logic.

    // The acceptance criteria says: "PQDB_DASHBOARD_URL env var" is required.
    // We verify this by directly testing the behavior.
    delete process.env.PQDB_DASHBOARD_URL;
    delete process.env.PQDB_API_KEY;

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://localhost:3002/mcp",
      recoveryFile: undefined,
    });

    // Import the startProxy function
    const { startProxy } = await import("../../src/cli.js");

    await expect(startProxy(config)).rejects.toThrow("PQDB_DASHBOARD_URL");
  });

  it("calls proxyLogin() before createCryptoProxyServer()", async () => {
    process.env.PQDB_DASHBOARD_URL = "https://localhost:8443";
    delete process.env.PQDB_API_KEY;

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://localhost:3002/mcp",
      recoveryFile: undefined,
    });

    const { startProxy } = await import("../../src/cli.js");
    await startProxy(config);

    expect(callOrder).toEqual(["proxyLogin", "createCryptoProxyServer"]);
  });

  it("passes dashboardUrl from PQDB_DASHBOARD_URL to proxyLogin()", async () => {
    process.env.PQDB_DASHBOARD_URL = "https://my-dash.example.com";
    delete process.env.PQDB_API_KEY;

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://localhost:3002/mcp",
      recoveryFile: undefined,
    });

    const { startProxy } = await import("../../src/cli.js");
    await startProxy(config);

    expect(mockProxyLogin).toHaveBeenCalledWith("https://my-dash.example.com");
  });

  it("populates ProxyConfig.authToken with the JWT from proxyLogin()", async () => {
    process.env.PQDB_DASHBOARD_URL = "https://localhost:8443";
    delete process.env.PQDB_API_KEY;

    mockProxyLogin.mockResolvedValue({
      devJwt: "my-special-jwt-999",
    });

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://localhost:3002/mcp",
      recoveryFile: undefined,
    });

    const { startProxy } = await import("../../src/cli.js");
    await startProxy(config);

    // Verify createCryptoProxyServer was called with the JWT as authToken
    expect(mockCreateCryptoProxyServer).toHaveBeenCalledOnce();
    const proxyConfig = mockCreateCryptoProxyServer.mock.calls[0][0];
    expect(proxyConfig.authToken).toBe("my-special-jwt-999");
  });

  it("connects stdio transport after createCryptoProxyServer()", async () => {
    process.env.PQDB_DASHBOARD_URL = "https://localhost:8443";
    delete process.env.PQDB_API_KEY;

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://localhost:3002/mcp",
      recoveryFile: undefined,
    });

    const { startProxy } = await import("../../src/cli.js");
    await startProxy(config);

    expect(MockStdioServerTransport).toHaveBeenCalledOnce();
    expect(mockMcpConnect).toHaveBeenCalledWith(mockStdioTransportInstance);
  });

  it("logs connection message with target URL", async () => {
    process.env.PQDB_DASHBOARD_URL = "https://localhost:8443";
    delete process.env.PQDB_API_KEY;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://localhost:3002/mcp",
      recoveryFile: undefined,
    });

    const { startProxy } = await import("../../src/cli.js");
    await startProxy(config);

    // Verify the expected log message
    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logCalls).toContainEqual(
      expect.stringContaining("[pqdb-proxy] Crypto proxy connected to http://localhost:3002/mcp"),
    );

    consoleSpy.mockRestore();
  });

  it("propagates login timeout error", async () => {
    process.env.PQDB_DASHBOARD_URL = "https://localhost:8443";
    delete process.env.PQDB_API_KEY;

    mockProxyLogin.mockRejectedValue(
      new Error("Login timed out. Please restart and try again."),
    );

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://localhost:3002/mcp",
      recoveryFile: undefined,
    });

    const { startProxy } = await import("../../src/cli.js");
    await expect(startProxy(config)).rejects.toThrow("Login timed out");
  });

  it("passes correct targetUrl and backendUrl in ProxyConfig", async () => {
    process.env.PQDB_DASHBOARD_URL = "https://localhost:8443";
    delete process.env.PQDB_API_KEY;

    const { buildConfig } = await import("../../src/config.js");
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
      mode: "proxy",
      target: "http://hosted:3002/mcp",
      recoveryFile: undefined,
    });

    const { startProxy } = await import("../../src/cli.js");
    await startProxy(config);

    const proxyConfig = mockCreateCryptoProxyServer.mock.calls[0][0];
    expect(proxyConfig.targetUrl).toBe("http://hosted:3002/mcp");
    expect(proxyConfig.backendUrl).toBe("http://localhost:8000");
  });
});
