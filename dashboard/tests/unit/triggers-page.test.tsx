import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchTriggers } = vi.hoisted(() => ({
  mockFetchTriggers: vi.fn(),
}));

vi.mock("~/lib/introspection", () => ({
  fetchFunctions: vi.fn().mockResolvedValue([]),
  fetchTriggers: mockFetchTriggers,
}));

import { TriggersPage } from "~/components/triggers-page";

const mockTriggersData = [
  {
    name: "audit_log_trigger",
    table: "users",
    timing: "AFTER",
    events: ["INSERT", "UPDATE"],
    function_name: "log_changes",
  },
  {
    name: "validate_email_trigger",
    table: "accounts",
    timing: "BEFORE",
    events: ["INSERT"],
    function_name: "validate_email",
  },
];

describe("TriggersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton while fetching", () => {
    mockFetchTriggers.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<TriggersPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(screen.getByTestId("triggers-loading")).toBeInTheDocument();
  });

  it("shows empty state when no triggers exist", async () => {
    mockFetchTriggers.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<TriggersPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(await screen.findByText(/no triggers/i)).toBeInTheDocument();
  });

  it("renders trigger list with names", async () => {
    mockFetchTriggers.mockResolvedValueOnce(mockTriggersData);
    const { wrapper } = createQueryWrapper();
    render(<TriggersPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(await screen.findByText("audit_log_trigger")).toBeInTheDocument();
    expect(screen.getByText("validate_email_trigger")).toBeInTheDocument();
  });

  it("displays trigger details: table, timing, events", async () => {
    mockFetchTriggers.mockResolvedValueOnce(mockTriggersData);
    const { wrapper } = createQueryWrapper();
    render(<TriggersPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    await screen.findByText("audit_log_trigger");
    // Table names
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.getByText("accounts")).toBeInTheDocument();
    // Timing badges
    expect(screen.getByText("AFTER")).toBeInTheDocument();
    expect(screen.getByText("BEFORE")).toBeInTheDocument();
  });

  it("displays event badges for each trigger", async () => {
    mockFetchTriggers.mockResolvedValueOnce(mockTriggersData);
    const { wrapper } = createQueryWrapper();
    render(<TriggersPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    await screen.findByText("audit_log_trigger");
    expect(screen.getAllByText("INSERT")).toHaveLength(2);
    expect(screen.getByText("UPDATE")).toBeInTheDocument();
  });

  it("displays trigger function name", async () => {
    mockFetchTriggers.mockResolvedValueOnce(mockTriggersData);
    const { wrapper } = createQueryWrapper();
    render(<TriggersPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    await screen.findByText("audit_log_trigger");
    expect(screen.getByText("log_changes")).toBeInTheDocument();
    expect(screen.getByText("validate_email")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchTriggers.mockRejectedValueOnce(new Error("Network error"));
    const { wrapper } = createQueryWrapper();
    render(<TriggersPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
  });
});
