import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchWebhooks, mockCreateWebhook, mockDeleteWebhook, mockFetchTables } = vi.hoisted(() => ({
  mockFetchWebhooks: vi.fn(),
  mockCreateWebhook: vi.fn(),
  mockDeleteWebhook: vi.fn(),
  mockFetchTables: vi.fn(),
}));

vi.mock("~/lib/webhooks", () => ({
  fetchWebhooks: mockFetchWebhooks,
  createWebhook: mockCreateWebhook,
  deleteWebhook: mockDeleteWebhook,
}));

vi.mock("~/lib/table-data", () => ({
  fetchTables: mockFetchTables,
}));

import { WebhooksPage } from "~/components/webhooks-page";
import type { Webhook } from "~/lib/webhooks";

const mockWebhookList: Webhook[] = [
  {
    id: 1,
    table_name: "users",
    events: ["INSERT", "UPDATE"],
    url: "https://example.com/hook1",
    active: true,
    created_at: "2026-03-30T10:00:00+00:00",
  },
  {
    id: 2,
    table_name: "orders",
    events: ["DELETE"],
    url: "https://example.com/hook2",
    active: false,
    created_at: "2026-03-30T11:00:00+00:00",
  },
];

describe("WebhooksPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchTables.mockResolvedValue([
      { name: "users", columns: [] },
      { name: "orders", columns: [] },
    ]);
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchWebhooks.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(screen.getByTestId("webhooks-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchWebhooks.mockRejectedValueOnce(new Error("Failed to fetch webhooks"));
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(
      await screen.findByText(/failed to fetch webhooks/i),
    ).toBeInTheDocument();
  });

  it("shows empty state when no webhooks configured", async () => {
    mockFetchWebhooks.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(
      await screen.findByText(/no webhooks configured/i),
    ).toBeInTheDocument();
  });

  it("renders webhook list with table names", async () => {
    mockFetchWebhooks.mockResolvedValueOnce(mockWebhookList);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("renders event badges for each webhook", async () => {
    mockFetchWebhooks.mockResolvedValueOnce(mockWebhookList);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await screen.findByText("users");
    expect(screen.getByText("INSERT")).toBeInTheDocument();
    expect(screen.getByText("UPDATE")).toBeInTheDocument();
    expect(screen.getByText("DELETE")).toBeInTheDocument();
  });

  it("renders webhook URLs", async () => {
    mockFetchWebhooks.mockResolvedValueOnce(mockWebhookList);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(await screen.findByText("https://example.com/hook1")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/hook2")).toBeInTheDocument();
  });

  it("shows active/inactive status indicators", async () => {
    mockFetchWebhooks.mockResolvedValueOnce(mockWebhookList);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await screen.findByText("users");
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("shows delete buttons for each webhook", async () => {
    mockFetchWebhooks.mockResolvedValueOnce(mockWebhookList);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await screen.findByText("users");
    const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
    expect(deleteButtons).toHaveLength(2);
  });

  it("shows Add Webhook button", async () => {
    mockFetchWebhooks.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await screen.findByText(/no webhooks configured/i);
    expect(screen.getByRole("button", { name: /add webhook/i })).toBeInTheDocument();
  });

  it("opens add webhook dialog when clicking Add Webhook", async () => {
    mockFetchWebhooks.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await screen.findByText(/no webhooks configured/i);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /add webhook/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/configure a webhook to receive/i)).toBeInTheDocument();
  });

  it("shows delete confirmation dialog when clicking delete", async () => {
    mockFetchWebhooks.mockResolvedValueOnce(mockWebhookList);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await screen.findByText("users");

    const user = userEvent.setup();
    const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
    await user.click(deleteButtons[0]);
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
  });

  it("calls deleteWebhook when confirming delete", async () => {
    mockFetchWebhooks.mockResolvedValueOnce(mockWebhookList);
    mockDeleteWebhook.mockResolvedValueOnce(undefined);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    await screen.findByText("users");

    const user = userEvent.setup();
    const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
    await user.click(deleteButtons[0]);

    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockDeleteWebhook).toHaveBeenCalledWith("pqdb_service_abc", 1);
    });
  });

  it("renders the page title", async () => {
    mockFetchWebhooks.mockResolvedValueOnce([]);
    const { wrapper } = createQueryWrapper();
    render(<WebhooksPage projectId="p1" apiKey="pqdb_service_abc" />, { wrapper });
    expect(await screen.findByText("Webhooks")).toBeInTheDocument();
  });
});
