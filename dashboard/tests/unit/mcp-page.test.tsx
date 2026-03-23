import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

// Mock clipboard API
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

const { mockExecuteMcpTool, MOCK_MCP_TOOLS } = vi.hoisted(() => ({
  mockExecuteMcpTool: vi.fn(),
  MOCK_MCP_TOOLS: [
    {
      name: "pqdb_status",
      description: "Check pqdb MCP server status and connection info",
      category: "status",
      parameters: {},
    },
    {
      name: "pqdb_list_tables",
      description: "List all tables with column count and sensitivity summary",
      category: "schema",
      parameters: {},
    },
    {
      name: "pqdb_describe_table",
      description: "Describe full schema for a table — columns, types, sensitivity levels, valid operations",
      category: "schema",
      parameters: {
        table_name: { type: "string", description: "Name of the table to describe" },
      },
    },
    {
      name: "pqdb_describe_schema",
      description: "ERD-style overview of all tables with columns, types, sensitivity, and foreign key relationships",
      category: "schema",
      parameters: {},
    },
    {
      name: "pqdb_query_rows",
      description: "Query rows from a table with optional filters, column selection, ordering, and pagination",
      category: "crud",
      parameters: {
        table: { type: "string", description: "Name of the table to query" },
      },
    },
    {
      name: "pqdb_insert_rows",
      description: "Insert one or more rows into a table",
      category: "crud",
      parameters: {
        table: { type: "string", description: "Name of the table to insert into" },
        rows: { type: "array", description: "Array of row objects to insert" },
      },
    },
    {
      name: "pqdb_update_rows",
      description: "Update rows in a table matching the given filters",
      category: "crud",
      parameters: {
        table: { type: "string", description: "Name of the table to update" },
      },
    },
    {
      name: "pqdb_delete_rows",
      description: "Delete rows from a table matching the given filters",
      category: "crud",
      parameters: {
        table: { type: "string", description: "Name of the table to delete from" },
      },
    },
    {
      name: "pqdb_list_users",
      description: "List all end-users in the project. Requires a service_role API key.",
      category: "auth",
      parameters: {},
    },
    {
      name: "pqdb_list_roles",
      description: "List all configured roles (built-in and custom) in the project",
      category: "auth",
      parameters: {},
    },
    {
      name: "pqdb_list_policies",
      description: "List all RLS policies for a specific table",
      category: "auth",
      parameters: {
        table_name: { type: "string", description: "Name of the table to list policies for" },
      },
    },
    {
      name: "pqdb_natural_language_query",
      description: 'Execute a natural language query against the database. Examples: "show all users", "get posts where title = Hello"',
      category: "query",
      parameters: {
        query: { type: "string", description: "Natural language query to execute" },
      },
    },
  ],
}));

vi.mock("~/lib/mcp", () => ({
  MCP_TOOLS: MOCK_MCP_TOOLS,
  fetchMcpTools: () => MOCK_MCP_TOOLS,
  executeMcpTool: (...args: unknown[]) => mockExecuteMcpTool(...args),
  buildMcpConfigSnippet: (_projectId: string) => ({
    mcpServers: {
      pqdb: {
        command: "npx",
        args: ["pqdb-mcp", "--project-url", "https://localhost"],
        env: {
          PQDB_API_KEY: "<your-api-key>",
          PQDB_PROJECT_URL: "https://localhost",
          PQDB_ENCRYPTION_KEY: "<your-encryption-key>",
        },
      },
    },
  }),
}));

import { McpPage } from "~/components/mcp-page";

describe("McpPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the MCP page title", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByText("MCP Server")).toBeInTheDocument();
  });

  it("shows connection info section", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByTestId("mcp-connection-info")).toBeInTheDocument();
  });

  it("displays stdio command", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    // Appears in both stdio and SSE commands
    expect(screen.getAllByText(/npx pqdb-mcp/).length).toBeGreaterThanOrEqual(1);
  });

  it("displays SSE URL", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByText(/--transport sse/)).toBeInTheDocument();
  });

  it("displays required environment variables", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    // Env var names appear in both connection info and config snippet
    expect(screen.getAllByText("PQDB_API_KEY").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("PQDB_PROJECT_URL").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("PQDB_ENCRYPTION_KEY").length).toBeGreaterThanOrEqual(1);
  });

  it("shows copy-to-clipboard button for MCP config JSON", async () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    const copyButton = screen.getByTestId("copy-mcp-config");
    expect(copyButton).toBeInTheDocument();

    await userEvent.click(copyButton);
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);

    const copiedText = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const parsed = JSON.parse(copiedText);
    expect(parsed).toHaveProperty("mcpServers");
    expect(parsed.mcpServers).toHaveProperty("pqdb");
  });

  it("lists all available MCP tools", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });

    expect(screen.getByTestId("mcp-tools-list")).toBeInTheDocument();
    expect(screen.getByText("pqdb_list_tables")).toBeInTheDocument();
    expect(screen.getByText("pqdb_describe_table")).toBeInTheDocument();
    expect(screen.getByText("pqdb_query_rows")).toBeInTheDocument();
    expect(screen.getByText("pqdb_insert_rows")).toBeInTheDocument();
    expect(screen.getByText("pqdb_update_rows")).toBeInTheDocument();
    expect(screen.getByText("pqdb_delete_rows")).toBeInTheDocument();
    expect(screen.getByText("pqdb_list_users")).toBeInTheDocument();
    expect(screen.getByText("pqdb_list_roles")).toBeInTheDocument();
    expect(screen.getByText("pqdb_list_policies")).toBeInTheDocument();
    expect(screen.getByText("pqdb_natural_language_query")).toBeInTheDocument();
  });

  it("shows tool descriptions", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });

    expect(
      screen.getByText(
        "List all tables with column count and sensitivity summary",
      ),
    ).toBeInTheDocument();
  });

  it("groups tools by category", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });

    // Category group headings exist (multiple "Schema" etc. due to badges on each tool)
    expect(screen.getAllByText("Schema").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("CRUD").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Auth").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Query").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the Test Tool section", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByTestId("mcp-test-tool")).toBeInTheDocument();
  });

  it("shows execute button in Test Tool section", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByTestId("execute-tool-button")).toBeInTheDocument();
  });

  it("shows MCP config JSON snippet", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByTestId("mcp-config-snippet")).toBeInTheDocument();
  });

  it("MCP config snippet contains correct structure", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    const snippet = screen.getByTestId("mcp-config-snippet");
    const text = snippet.textContent ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.pqdb.command).toBe("npx");
    expect(parsed.mcpServers.pqdb.args).toContain("pqdb-mcp");
    expect(parsed.mcpServers.pqdb.env).toHaveProperty("PQDB_API_KEY");
    expect(parsed.mcpServers.pqdb.env).toHaveProperty("PQDB_PROJECT_URL");
  });

  it("shows tool count badge", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByText("12 tools")).toBeInTheDocument();
  });

  it("displays the pqdb_status tool", () => {
    const { wrapper } = createQueryWrapper();
    render(<McpPage projectId="proj-123" />, { wrapper });
    expect(screen.getByText("pqdb_status")).toBeInTheDocument();
  });
});
