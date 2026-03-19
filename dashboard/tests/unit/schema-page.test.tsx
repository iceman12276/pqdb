import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchSchema, mockAddColumn } = vi.hoisted(() => ({
  mockFetchSchema: vi.fn(),
  mockAddColumn: vi.fn(),
}));

vi.mock("~/lib/schema", () => ({
  fetchSchema: mockFetchSchema,
  addColumn: mockAddColumn,
  getPhysicalColumns: (col: { name: string; type: string; sensitivity: string }) => {
    if (col.sensitivity === "searchable") {
      return [
        { name: `${col.name}_encrypted`, type: "bytea" },
        { name: `${col.name}_index`, type: "text" },
      ];
    }
    if (col.sensitivity === "private") {
      return [{ name: `${col.name}_encrypted`, type: "bytea" }];
    }
    return [{ name: col.name, type: col.type }];
  },
}));

import { SchemaPage } from "~/components/schema-page";
import type { IntrospectionTable } from "~/lib/schema";

const mockTables: IntrospectionTable[] = [
  {
    name: "users",
    columns: [
      {
        name: "id",
        type: "uuid",
        sensitivity: "plain",
        is_owner: true,
        queryable: true,
        operations: ["eq", "gt", "lt", "gte", "lte", "in", "between"],
      },
      {
        name: "email",
        type: "text",
        sensitivity: "searchable",
        is_owner: false,
        queryable: true,
        operations: ["eq", "in"],
      },
      {
        name: "ssn",
        type: "text",
        sensitivity: "private",
        is_owner: false,
        queryable: false,
        note: "retrieve only — no server-side filtering",
      },
      {
        name: "name",
        type: "text",
        sensitivity: "plain",
        is_owner: false,
        queryable: true,
        operations: ["eq", "gt", "lt", "gte", "lte", "in", "between"],
      },
    ],
    sensitivity_summary: { plain: 2, searchable: 1, private: 1 },
  },
  {
    name: "posts",
    columns: [
      {
        name: "id",
        type: "uuid",
        sensitivity: "plain",
        is_owner: false,
        queryable: true,
        operations: ["eq", "gt", "lt", "gte", "lte", "in", "between"],
      },
      {
        name: "user_id",
        type: "uuid",
        sensitivity: "plain",
        is_owner: true,
        queryable: true,
        operations: ["eq", "gt", "lt", "gte", "lte", "in", "between"],
      },
      {
        name: "title",
        type: "text",
        sensitivity: "plain",
        is_owner: false,
        queryable: true,
        operations: ["eq", "gt", "lt", "gte", "lte", "in", "between"],
      },
    ],
    sensitivity_summary: { plain: 3, searchable: 0, private: 0 },
  },
];

describe("SchemaPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton while fetching", () => {
    mockFetchSchema.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(screen.getByTestId("schema-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchSchema.mockRejectedValueOnce(new Error("Failed to fetch schema"));
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/failed to fetch schema/i)).toBeInTheDocument();
  });

  it("shows empty state when no tables exist", async () => {
    mockFetchSchema.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/no tables/i)).toBeInTheDocument();
  });

  it("renders table list in list view", async () => {
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("posts")).toBeInTheDocument();
  });

  it("renders columns for each table in list view", async () => {
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("email")).toBeInTheDocument();
    });
    expect(screen.getByText("ssn")).toBeInTheDocument();
    expect(screen.getByText("title")).toBeInTheDocument();
  });

  it("shows sensitivity badges with correct colors", async () => {
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("email")).toBeInTheDocument();
    });

    // Find sensitivity badges
    const searchableBadges = screen.getAllByTestId("badge-searchable");
    const privateBadges = screen.getAllByTestId("badge-private");
    const plainBadges = screen.getAllByTestId("badge-plain");

    expect(searchableBadges.length).toBeGreaterThan(0);
    expect(privateBadges.length).toBeGreaterThan(0);
    expect(plainBadges.length).toBeGreaterThan(0);
  });

  it("shows owner icon for owner columns", async () => {
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("email")).toBeInTheDocument();
    });

    const ownerIcons = screen.getAllByTestId("owner-icon");
    // id in users (is_owner=true) and user_id in posts (is_owner=true)
    expect(ownerIcons).toHaveLength(2);
  });

  it("defaults to logical view showing developer-facing column names", async () => {
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("email")).toBeInTheDocument();
    });

    // In logical view, should show original names
    expect(screen.getByText("email")).toBeInTheDocument();
    expect(screen.getByText("ssn")).toBeInTheDocument();
    // Should NOT show physical names
    expect(screen.queryByText("email_encrypted")).not.toBeInTheDocument();
    expect(screen.queryByText("email_index")).not.toBeInTheDocument();
  });

  it("switches to physical view showing Postgres column names", async () => {
    const user = userEvent.setup();
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("email")).toBeInTheDocument();
    });

    // Click the physical view toggle
    const physicalToggle = screen.getByRole("button", { name: /physical/i });
    await user.click(physicalToggle);

    // Should show physical column names
    await waitFor(() => {
      expect(screen.getByText("email_encrypted")).toBeInTheDocument();
    });
    expect(screen.getByText("email_index")).toBeInTheDocument();
    expect(screen.getByText("ssn_encrypted")).toBeInTheDocument();
  });

  it("has tabs for List and ERD views", async () => {
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("users")).toBeInTheDocument();
    });

    expect(screen.getByRole("tab", { name: /list/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /erd/i })).toBeInTheDocument();
  });

  it("switches to ERD view and renders table nodes", async () => {
    const user = userEvent.setup();
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("users")).toBeInTheDocument();
    });

    const erdTab = screen.getByRole("tab", { name: /erd/i });
    await user.click(erdTab);

    await waitFor(() => {
      expect(screen.getByTestId("erd-view")).toBeInTheDocument();
    });
  });
});

describe("SchemaPage — Add Column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Add Column button for each table", async () => {
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("users")).toBeInTheDocument();
    });

    const addButtons = screen.getAllByRole("button", { name: /add column/i });
    expect(addButtons).toHaveLength(2); // one per table
  });

  it("opens add column dialog when clicking Add Column", async () => {
    const user = userEvent.setup();
    mockFetchSchema.mockResolvedValueOnce(mockTables);
    const { wrapper } = createQueryWrapper();
    render(<SchemaPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("users")).toBeInTheDocument();
    });

    const addButtons = screen.getAllByRole("button", { name: /add column/i });
    await user.click(addButtons[0]);

    expect(await screen.findByText(/add column to/i)).toBeInTheDocument();
  });
});
