/**
 * Unit tests for the realtime WebSocket client.
 *
 * Uses a mock WebSocket to test:
 * - subscribe/unsubscribe protocol
 * - event dispatching with decryption
 * - auto-reconnect with exponential backoff
 * - heartbeat monitoring
 * - shared WebSocket across subscriptions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RealtimeClient,
  type RealtimeEvent,
  type Subscription,
} from "../../src/client/realtime.js";
import type { TableSchema } from "../../src/query/schema.js";

// ---------------------------------------------------------------------------
// CloseEvent polyfill for Node.js test environment
// ---------------------------------------------------------------------------
class MockCloseEvent {
  readonly type: string;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  constructor(type: string, init?: { code?: number; reason?: string }) {
    this.type = type;
    this.code = init?.code ?? 1000;
    this.reason = init?.reason ?? "";
    this.wasClean = this.code === 1000;
  }
}

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    // Auto-open on next tick
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new MockCloseEvent("close", { code: code ?? 1000, reason: reason ?? "" }));
  }

  // Test helpers
  simulateMessage(data: Record<string, unknown>): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }

  simulateError(): void {
    this.onerror?.(new Event("error"));
  }

  simulateClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new MockCloseEvent("close", { code }));
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const plainSchema: TableSchema = {
  name: "messages",
  columns: {
    id: { type: "uuid", sensitivity: "plain", isPrimaryKey: true } as any,
    content: { type: "text", sensitivity: "plain", isPrimaryKey: false } as any,
  },
};

const sensitiveSchema: TableSchema = {
  name: "users",
  columns: {
    id: { type: "uuid", sensitivity: "plain", isPrimaryKey: true } as any,
    email: {
      type: "text",
      sensitivity: "searchable",
      isPrimaryKey: false,
    } as any,
    ssn: { type: "text", sensitivity: "private", isPrimaryKey: false } as any,
  },
};

let mockWsInstances: MockWebSocket[];
let originalWebSocket: typeof globalThis.WebSocket;

function createRealtimeClient(opts?: {
  decryptRow?: (
    row: Record<string, unknown>,
    schema: TableSchema,
  ) => Promise<Record<string, unknown>>;
}): RealtimeClient {
  return new RealtimeClient({
    baseUrl: "http://localhost:8000",
    apiKey: "pqdb_anon_abc123",
    token: "jwt-token-here",
    decryptRow: opts?.decryptRow ?? null,
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  mockWsInstances = [];
  originalWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWsInstances.push(this);
    }
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RealtimeClient", () => {
  describe("subscribe()", () => {
    it("connects WebSocket with correct URL params", async () => {
      const rt = createRealtimeClient();
      const cb = vi.fn();

      rt.on(plainSchema, "insert", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0); // let microtask resolve

      expect(mockWsInstances).toHaveLength(1);
      const ws = mockWsInstances[0];
      expect(ws.url).toBe(
        "ws://localhost:8000/v1/realtime?apikey=pqdb_anon_abc123&token=jwt-token-here",
      );
    });

    it("converts https to wss", async () => {
      const rt = new RealtimeClient({
        baseUrl: "https://api.pqdb.io",
        apiKey: "pqdb_anon_key",
        token: "t",
        decryptRow: null,
      });

      rt.on(plainSchema, "*", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWsInstances[0].url).toMatch(/^wss:\/\//);
    });

    it("sends subscribe message on connection open", async () => {
      const rt = createRealtimeClient();
      rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);

      const ws = mockWsInstances[0];
      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0])).toEqual({
        type: "subscribe",
        table: "messages",
      });
    });

    it("returns { data, error } on subscribe", async () => {
      const rt = createRealtimeClient();
      const subPromise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);

      // Simulate ack
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });

      const result = await subPromise;
      expect(result.data).toBeDefined();
      expect(result.error).toBeNull();
    });

    it("returns error when subscribe fails", async () => {
      const rt = createRealtimeClient();
      const subPromise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);

      // Simulate error response
      mockWsInstances[0].simulateMessage({
        type: "error",
        message: "Maximum table subscriptions reached (50)",
      });

      const result = await subPromise;
      expect(result.data).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain("Maximum table subscriptions");
    });

    it("shares WebSocket across multiple subscriptions", async () => {
      const rt = createRealtimeClient();

      rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });

      const schema2: TableSchema = {
        name: "posts",
        columns: {
          id: { type: "uuid", sensitivity: "plain", isPrimaryKey: true } as any,
        },
      };

      rt.on(schema2, "delete", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);

      // Should reuse the same WebSocket
      expect(mockWsInstances).toHaveLength(1);
      // Should have sent a second subscribe message
      expect(mockWsInstances[0].sentMessages).toHaveLength(2);
      expect(JSON.parse(mockWsInstances[0].sentMessages[1])).toEqual({
        type: "subscribe",
        table: "posts",
      });
    });
  });

  describe("event dispatch", () => {
    it("invokes callback for matching event type", async () => {
      const rt = createRealtimeClient();
      const cb = vi.fn();

      const subPromise = rt.on(plainSchema, "insert", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "messages",
        event: "INSERT",
        row: { id: "1", content: "hello" },
      });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({
        event: "insert",
        row: { id: "1", content: "hello" },
      });
    });

    it("does not invoke callback for non-matching event type", async () => {
      const rt = createRealtimeClient();
      const cb = vi.fn();

      const subPromise = rt.on(plainSchema, "insert", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "messages",
        event: "DELETE",
        row: { id: "1" },
      });

      expect(cb).not.toHaveBeenCalled();
    });

    it("'*' event matches all event types", async () => {
      const rt = createRealtimeClient();
      const cb = vi.fn();

      const subPromise = rt.on(plainSchema, "*", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "messages",
        event: "INSERT",
        row: { id: "1", content: "a" },
      });
      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "messages",
        event: "UPDATE",
        row: { id: "1", content: "b" },
      });
      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "messages",
        event: "DELETE",
        row: { id: "1" },
      });

      expect(cb).toHaveBeenCalledTimes(3);
    });

    it("delete events contain only { id }", async () => {
      const rt = createRealtimeClient();
      const cb = vi.fn();

      const subPromise = rt.on(plainSchema, "*", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "messages",
        event: "DELETE",
        row: { id: "42" },
      });

      expect(cb).toHaveBeenCalledWith({
        event: "delete",
        row: { id: "42" },
      });
    });

    it("decrypts sensitive columns before invoking callback", async () => {
      const decryptRow = vi.fn().mockImplementation(async (row, _schema) => {
        // Simulate decryption: return plaintext columns, strip shadow columns
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!key.endsWith("_encrypted") && !key.endsWith("_index")) {
            result[key] = value;
          }
        }
        result.email = "decrypted@example.com";
        result.ssn = "123-45-6789";
        return result;
      });
      const rt = createRealtimeClient({ decryptRow });
      const cb = vi.fn();

      const subPromise = rt.on(sensitiveSchema, "insert", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "users",
      });
      await subPromise;

      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "users",
        event: "INSERT",
        row: {
          id: "1",
          email_encrypted: "base64cipher",
          email_index: "hmac_hash",
          ssn_encrypted: "base64cipher2",
        },
      });

      // Wait for async decryption
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(decryptRow).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({
        event: "insert",
        row: { id: "1", email: "decrypted@example.com", ssn: "123-45-6789" },
      });
    });

    it("skips decryption for delete events", async () => {
      const decryptRow = vi.fn();
      const rt = createRealtimeClient({ decryptRow });
      const cb = vi.fn();

      const subPromise = rt.on(sensitiveSchema, "*", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "users",
      });
      await subPromise;

      mockWsInstances[0].simulateMessage({
        type: "event",
        table: "users",
        event: "DELETE",
        row: { id: "42" },
      });

      expect(decryptRow).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith({ event: "delete", row: { id: "42" } });
    });
  });

  describe("unsubscribe()", () => {
    it("sends unsubscribe message and removes callback", async () => {
      const rt = createRealtimeClient();
      const cb = vi.fn();

      const subPromise = rt.on(plainSchema, "insert", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      const result = await subPromise;
      const subscription = result.data!;

      subscription.unsubscribe();
      const ws = mockWsInstances[0];
      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg).toEqual({ type: "unsubscribe", table: "messages" });

      // Events after unsubscribe should not invoke callback
      ws.simulateMessage({
        type: "event",
        table: "messages",
        event: "INSERT",
        row: { id: "1", content: "hello" },
      });
      expect(cb).not.toHaveBeenCalled();
    });

    it("closes WebSocket when last subscription is removed", async () => {
      const rt = createRealtimeClient();

      const subPromise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      const result = await subPromise;

      result.data!.unsubscribe();
      expect(mockWsInstances[0].readyState).toBe(MockWebSocket.CLOSED);
    });
  });

  describe("reconnect", () => {
    it("reconnects with exponential backoff on unexpected close", async () => {
      const rt = createRealtimeClient();
      const cb = vi.fn();

      const subPromise = rt.on(plainSchema, "insert", cb).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      // Simulate unexpected close — attempt 0, backoff = 1s
      mockWsInstances[0].simulateClose(1006);
      await vi.advanceTimersByTimeAsync(999);
      expect(mockWsInstances).toHaveLength(1); // not yet
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0); // flush microtask for onopen
      expect(mockWsInstances).toHaveLength(2);

      // Simulate second close — attempt 1, backoff = 2s
      mockWsInstances[1].simulateClose(1006);
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockWsInstances).toHaveLength(2); // not yet
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockWsInstances).toHaveLength(3);

      // Third close — attempt 2, backoff = 4s
      mockWsInstances[2].simulateClose(1006);
      await vi.advanceTimersByTimeAsync(3999);
      expect(mockWsInstances).toHaveLength(3); // not yet
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockWsInstances).toHaveLength(4);
    });

    it("caps backoff at 32 seconds", async () => {
      const rt = createRealtimeClient();

      const subPromise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      // Simulate 6 closes to reach 32s cap
      // Backoffs: 1s, 2s, 4s, 8s, 16s, 32s (attempts 0-5)
      for (let i = 0; i < 6; i++) {
        const currentIdx = mockWsInstances.length - 1;
        mockWsInstances[currentIdx].simulateClose(1006);
        const delay = Math.min(2 ** i * 1000, 32000);
        await vi.advanceTimersByTimeAsync(delay);
        await vi.advanceTimersByTimeAsync(0); // flush microtask for onopen
      }
      expect(mockWsInstances).toHaveLength(7); // initial + 6 reconnects

      // After 6 reconnects (attempt=6), backoff = min(2^6*1000, 32000) = 32000
      const currentIdx = mockWsInstances.length - 1;
      mockWsInstances[currentIdx].simulateClose(1006);
      await vi.advanceTimersByTimeAsync(31999);
      expect(mockWsInstances).toHaveLength(7); // not yet
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockWsInstances).toHaveLength(8);
    });

    it("resubscribes all active subscriptions on reconnect", async () => {
      const rt = createRealtimeClient();

      const sub1Promise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await sub1Promise;

      const schema2: TableSchema = {
        name: "posts",
        columns: {
          id: { type: "uuid", sensitivity: "plain", isPrimaryKey: true } as any,
        },
      };
      const sub2Promise = rt.on(schema2, "delete", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "posts",
      });
      await sub2Promise;

      // Simulate disconnect
      mockWsInstances[0].simulateClose(1006);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0); // let microtask fire

      // New WebSocket should re-subscribe to both tables
      const ws = mockWsInstances[1];
      const subscribeMsgs = ws.sentMessages
        .map((m) => JSON.parse(m))
        .filter((m: any) => m.type === "subscribe");
      const subscribedTables = subscribeMsgs.map((m: any) => m.table).sort();
      expect(subscribedTables).toEqual(["messages", "posts"]);
    });

    it("does not reconnect on intentional close (unsubscribe all)", async () => {
      const rt = createRealtimeClient();

      const subPromise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      const result = await subPromise;

      // Intentional unsubscribe
      result.data!.unsubscribe();

      // Wait longer than any backoff
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockWsInstances).toHaveLength(1);
    });
  });

  describe("heartbeat monitoring", () => {
    it("reconnects if no heartbeat within 60 seconds", async () => {
      const rt = createRealtimeClient();

      const subPromise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      // Advance 59 seconds — no reconnect
      await vi.advanceTimersByTimeAsync(59000);
      expect(mockWsInstances).toHaveLength(1);

      // At 60s: heartbeat timeout fires → ws.close(4000) → handleClose → scheduleReconnect (1s)
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockWsInstances).toHaveLength(1); // close happened but reconnect timer not yet

      // At 61s: reconnect timer fires → new WebSocket
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0); // flush microtask for onopen
      expect(mockWsInstances).toHaveLength(2);
    });

    it("resets heartbeat timer on heartbeat message", async () => {
      const rt = createRealtimeClient();

      const subPromise = rt.on(plainSchema, "insert", vi.fn()).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      mockWsInstances[0].simulateMessage({
        type: "ack",
        action: "subscribe",
        table: "messages",
      });
      await subPromise;

      // At 30 seconds, receive a heartbeat — resets the 60s timer
      await vi.advanceTimersByTimeAsync(30000);
      mockWsInstances[0].simulateMessage({
        type: "heartbeat",
        timestamp: Date.now() / 1000,
      });

      // At 80 seconds total (50 seconds after last heartbeat) — no timeout yet
      await vi.advanceTimersByTimeAsync(50000);
      expect(mockWsInstances).toHaveLength(1);

      // At 90s total (60s after heartbeat): timeout fires → close → scheduleReconnect (1s)
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockWsInstances).toHaveLength(1); // close happened, reconnect pending

      // At 91s: reconnect timer fires
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockWsInstances).toHaveLength(2);
    });
  });

  describe("TypeScript types", () => {
    it("RealtimeEvent has correct shape", () => {
      const event: RealtimeEvent = {
        event: "insert",
        row: { id: "1", name: "test" },
      };
      expect(event.event).toBe("insert");
      expect(event.row).toEqual({ id: "1", name: "test" });
    });

    it("supports all event type literals", () => {
      const events: RealtimeEvent["event"][] = [
        "insert",
        "update",
        "delete",
      ];
      expect(events).toHaveLength(3);
    });
  });
});
