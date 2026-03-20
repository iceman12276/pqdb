import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

// Mock the project context to provide apiKey
const mockUseProjectContext = vi.hoisted(() =>
  vi.fn(() => ({
    project: { id: "proj-1", name: "Test Project" },
    apiKey: "pqdb_service_testkey123",
    loading: false,
    error: null,
  })),
);

vi.mock("~/lib/project-context", () => ({
  useProjectContext: mockUseProjectContext,
}));

import { RealtimePage } from "~/components/realtime-page";

// Helpers to capture and control the mock WebSocket
let mockWsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

describe("RealtimePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWsInstances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the page title", () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });
    expect(screen.getByText("Realtime")).toBeInTheDocument();
  });

  it("shows connection status as disconnected initially", () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });
    expect(screen.getByTestId("connection-status")).toHaveTextContent("Disconnected");
  });

  it("shows connection count card", () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });
    expect(screen.getByTestId("connections-count")).toBeInTheDocument();
  });

  it("shows subscriptions count card", () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });
    expect(screen.getByTestId("subscriptions-count")).toBeInTheDocument();
  });

  it("connects to WebSocket when connect button is clicked", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    const connectBtn = screen.getByTestId("connect-btn");
    await userEvent.click(connectBtn);

    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).toContain("apikey=pqdb_service_testkey123");
  });

  it("shows connected status after WebSocket opens", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    await waitFor(() => {
      expect(screen.getByTestId("connection-status")).toHaveTextContent("Connected");
    });
  });

  it("shows disconnect button when connected", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    await waitFor(() => {
      expect(screen.getByTestId("disconnect-btn")).toBeInTheDocument();
    });
  });

  it("displays incoming events in the event inspector", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    act(() => {
      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "users",
        event: "INSERT",
        row: { id: "row-1", name_encrypted: "abc123" },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("event-inspector")).toBeInTheDocument();
    });

    const eventRows = screen.getAllByTestId("event-row");
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toHaveTextContent("users");
    expect(eventRows[0]).toHaveTextContent("INSERT");
    expect(eventRows[0]).toHaveTextContent("row-1");
  });

  it("shows [encrypted] for encrypted columns in events", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    act(() => {
      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "users",
        event: "INSERT",
        row: { id: "row-1", email_encrypted: "ciphertext123", name: "Alice" },
      });
    });

    await waitFor(() => {
      const eventRows = screen.getAllByTestId("event-row");
      expect(eventRows[0]).toHaveTextContent("[encrypted]");
    });
  });

  it("shows subscribed tables list", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    // Subscribe to a table
    const tableInput = screen.getByTestId("subscribe-table-input");
    await userEvent.type(tableInput, "users");
    await userEvent.click(screen.getByTestId("subscribe-btn"));

    // Simulate ack from server
    act(() => {
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "users",
      });
    });

    await waitFor(() => {
      const container = screen.getByTestId("subscribed-tables");
      expect(container).toBeInTheDocument();
      expect(container).toHaveTextContent("users");
    });
  });

  it("sends subscribe message when subscribing to a table", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    const tableInput = screen.getByTestId("subscribe-table-input");
    await userEvent.type(tableInput, "orders");
    await userEvent.click(screen.getByTestId("subscribe-btn"));

    expect(mockWsInstances[0].sentMessages).toHaveLength(1);
    expect(JSON.parse(mockWsInstances[0].sentMessages[0])).toEqual({
      type: "subscribe",
      table: "orders",
    });
  });

  it("shows empty event inspector message when no events", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    expect(screen.getByTestId("events-empty")).toBeInTheDocument();
  });

  it("shows heartbeat events in inspector", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    act(() => {
      mockWsInstances[0].simulateMessage({
        type: "heartbeat",
        timestamp: 1710854400,
      });
    });

    await waitFor(() => {
      const eventRows = screen.getAllByTestId("event-row");
      expect(eventRows[0]).toHaveTextContent("heartbeat");
    });
  });

  it("disconnects when disconnect button is clicked", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    await waitFor(() => {
      expect(screen.getByTestId("disconnect-btn")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("disconnect-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("connection-status")).toHaveTextContent("Disconnected");
    });
  });

  it("clears events when clear button is clicked", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    act(() => {
      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "users",
        event: "INSERT",
        row: { id: "row-1" },
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("event-row")).toHaveLength(1);
    });

    await userEvent.click(screen.getByTestId("clear-events-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("events-empty")).toBeInTheDocument();
    });
  });

  it("shows event type badges for different event types", async () => {
    const { wrapper } = createQueryWrapper();
    render(<RealtimePage projectId="proj-1" />, { wrapper });

    await userEvent.click(screen.getByTestId("connect-btn"));

    act(() => {
      mockWsInstances[0].simulateOpen();
    });

    act(() => {
      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "users",
        event: "INSERT",
        row: { id: "r1" },
      });
    });

    act(() => {
      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "orders",
        event: "DELETE",
        row: { id: "r2" },
      });
    });

    await waitFor(() => {
      const eventRows = screen.getAllByTestId("event-row");
      expect(eventRows).toHaveLength(2);
    });

    // Most recent event first
    const badges = screen.getAllByTestId("event-type-badge");
    expect(badges[0]).toHaveTextContent("DELETE");
    expect(badges[1]).toHaveTextContent("INSERT");
  });
});
