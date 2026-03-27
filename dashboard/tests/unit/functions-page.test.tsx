import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchFunctions } = vi.hoisted(() => ({
  mockFetchFunctions: vi.fn(),
}));

vi.mock("~/lib/introspection", () => ({
  fetchFunctions: mockFetchFunctions,
  fetchTriggers: vi.fn().mockResolvedValue([]),
}));

import { FunctionsPage } from "~/components/functions-page";

const mockFunctionsData = [
  {
    name: "get_active_users",
    schema: "public",
    args: "min_age integer, active boolean",
    return_type: "SETOF users",
    language: "plpgsql",
    source:
      "BEGIN\n  RETURN QUERY SELECT * FROM users WHERE age >= min_age AND is_active = active;\nEND;",
  },
  {
    name: "calculate_total",
    schema: "public",
    args: "order_id uuid",
    return_type: "numeric",
    language: "sql",
    source: "SELECT SUM(amount) FROM line_items WHERE order_id = $1;",
  },
];

describe("FunctionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton while fetching", () => {
    mockFetchFunctions.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<FunctionsPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(screen.getByTestId("functions-loading")).toBeInTheDocument();
  });

  it("shows empty state when no functions exist", async () => {
    mockFetchFunctions.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<FunctionsPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(await screen.findByText(/no functions/i)).toBeInTheDocument();
  });

  it("renders function list with names", async () => {
    mockFetchFunctions.mockResolvedValueOnce(mockFunctionsData);
    const { wrapper } = createQueryWrapper();
    render(<FunctionsPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(await screen.findByText("get_active_users")).toBeInTheDocument();
    expect(screen.getByText("calculate_total")).toBeInTheDocument();
  });

  it("displays function details: return type, language, args", async () => {
    mockFetchFunctions.mockResolvedValueOnce(mockFunctionsData);
    const { wrapper } = createQueryWrapper();
    render(<FunctionsPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    await screen.findByText("get_active_users");
    expect(screen.getByText("plpgsql")).toBeInTheDocument();
    expect(screen.getByText("sql")).toBeInTheDocument();
    expect(screen.getByText("SETOF users")).toBeInTheDocument();
    expect(screen.getByText("numeric")).toBeInTheDocument();
  });

  it("displays function arguments", async () => {
    mockFetchFunctions.mockResolvedValueOnce(mockFunctionsData);
    const { wrapper } = createQueryWrapper();
    render(<FunctionsPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    await screen.findByText("get_active_users");
    expect(
      screen.getByText("min_age integer, active boolean"),
    ).toBeInTheDocument();
    expect(screen.getByText("order_id uuid")).toBeInTheDocument();
  });

  it("displays source code in a code block", async () => {
    mockFetchFunctions.mockResolvedValueOnce(mockFunctionsData);
    const { wrapper } = createQueryWrapper();
    render(<FunctionsPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    await screen.findByText("get_active_users");
    const codeBlocks = screen.getAllByTestId("function-source");
    expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(codeBlocks[0].textContent).toContain("RETURN QUERY");
  });

  it("shows error state on fetch failure", async () => {
    mockFetchFunctions.mockRejectedValueOnce(new Error("Network error"));
    const { wrapper } = createQueryWrapper();
    render(<FunctionsPage projectId="p1" apiKey="pqdb_service_abc" />, {
      wrapper,
    });
    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
  });
});
