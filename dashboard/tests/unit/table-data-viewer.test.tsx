import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EncryptionProvider } from "~/lib/encryption-context";

const {
  mockFetchTableRows,
  mockInsertRow,
  mockDeleteRow,
  mockFetchSchema,
} = vi.hoisted(() => ({
  mockFetchTableRows: vi.fn(),
  mockInsertRow: vi.fn(),
  mockDeleteRow: vi.fn(),
  mockFetchSchema: vi.fn(),
}));

vi.mock("~/lib/table-data", () => ({
  fetchTables: vi.fn().mockResolvedValue([]),
  fetchTableRows: mockFetchTableRows,
  insertRow: mockInsertRow,
  deleteRow: mockDeleteRow,
  fetchRowCount: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/lib/schema", () => ({
  fetchSchema: mockFetchSchema,
  getPhysicalColumns: vi.fn(),
}));

vi.mock("~/lib/pqc-decrypt", () => ({
  deriveSecretKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
  decryptValue: vi.fn().mockResolvedValue(null),
}));

import { TableDataViewer } from "~/components/table-data-viewer";
import type { IntrospectionTable } from "~/lib/schema";

const mockSchemaData: IntrospectionTable[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "uuid", sensitivity: "plain", is_owner: true, queryable: true },
      { name: "email", type: "text", sensitivity: "searchable", is_owner: false, queryable: true },
      { name: "ssn", type: "text", sensitivity: "private", is_owner: false, queryable: false },
      { name: "name", type: "text", sensitivity: "plain", is_owner: false, queryable: true },
    ],
    sensitivity_summary: { plain: 2, searchable: 1, private: 1 },
  },
];

const mockRowsData = [
  {
    id: "uuid-1",
    email_encrypted: "base64encrypteddata1",
    email_index: "v1:hmacindex1",
    ssn_encrypted: "base64encrypteddata2",
    name: "Alice",
  },
  {
    id: "uuid-2",
    email_encrypted: "base64encrypteddata3",
    email_index: "v1:hmacindex2",
    ssn_encrypted: "base64encrypteddata4",
    name: "Bob",
  },
];

function Wrapper({ children }: { children: React.ReactNode }) {
  const [qc] = React.useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={qc}>
      <EncryptionProvider>{children}</EncryptionProvider>
    </QueryClientProvider>
  );
}

describe("TableDataViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading while fetching data", () => {
    mockFetchTableRows.mockReturnValue(new Promise(() => {}));
    mockFetchSchema.mockReturnValue(new Promise(() => {}));
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );
    expect(screen.getByTestId("table-data-loading")).toBeInTheDocument();
  });

  it("renders table with column headers", async () => {
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("id")).toBeInTheDocument();
    });
    expect(screen.getByText("email")).toBeInTheDocument();
    expect(screen.getByText("ssn")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
  });

  it("displays plain column values directly", async () => {
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("shows [encrypted] placeholder for encrypted columns when locked", async () => {
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    const encryptedCells = screen.getAllByText("[encrypted]");
    expect(encryptedCells.length).toBe(4);
  });

  it("shows Unlock button when locked", async () => {
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /unlock/i })).toBeInTheDocument();
  });

  it("shows unlock dialog when clicking Unlock", async () => {
    const user = userEvent.setup();
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /unlock/i }));
    expect(await screen.findByText(/enter.*encryption key/i)).toBeInTheDocument();
  });

  it("shows zero-knowledge warning in the unlock dialog", async () => {
    const user = userEvent.setup();
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /unlock/i }));
    const warning = await screen.findByTestId("encryption-key-warning");
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/never sent to the server/i);
    expect(warning.textContent).toMatch(/permanently unrecoverable/i);
    expect(warning.textContent).toMatch(/store it securely/i);
  });

  it("allows dismissing the unlock dialog warning", async () => {
    const user = userEvent.setup();
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /unlock/i }));
    const warning = await screen.findByTestId("encryption-key-warning");
    expect(warning).toBeInTheDocument();

    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    await user.click(dismissBtn);
    expect(screen.queryByTestId("encryption-key-warning")).not.toBeInTheDocument();
  });

  it("shows insert row button", async () => {
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /insert row/i })).toBeInTheDocument();
  });

  it("shows delete button for each row", async () => {
    mockFetchTableRows.mockResolvedValueOnce(mockRowsData);
    mockFetchSchema.mockResolvedValueOnce(mockSchemaData);
    render(
      <Wrapper>
        <TableDataViewer projectId="p1" tableName="users" apiKey="pqdb_service_abc" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
    expect(deleteButtons.length).toBe(2);
  });
});
