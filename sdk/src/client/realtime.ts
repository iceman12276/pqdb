/**
 * Realtime WebSocket client for pqdb.
 *
 * Connects to the backend WebSocket at /v1/realtime, supports
 * subscribe/unsubscribe, event dispatch with decryption,
 * auto-reconnect with exponential backoff, and heartbeat monitoring.
 */
import type { TableSchema, SchemaColumns } from "../query/schema.js";
import type { PqdbResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Event types the client can listen for. */
export type RealtimeEventType = "insert" | "update" | "delete" | "*";

/** Payload delivered to event callbacks. */
export interface RealtimeEvent {
  event: "insert" | "update" | "delete";
  row: Record<string, unknown>;
}

/** Callback signature for realtime events. */
export type RealtimeCallback = (event: RealtimeEvent) => void;

/** Handle returned by a successful subscribe. */
export interface Subscription {
  /** Unsubscribe from this table and stop receiving events. */
  unsubscribe(): void;
}

/** Options for constructing a RealtimeClient. */
export interface RealtimeClientOptions {
  baseUrl: string;
  apiKey: string;
  token: string | null;
  decryptRow:
    | ((
        row: Record<string, unknown>,
        schema: TableSchema,
      ) => Promise<Record<string, unknown>>)
    | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SubscriptionEntry {
  table: string;
  schema: TableSchema;
  eventType: RealtimeEventType;
  callback: RealtimeCallback;
  active: boolean;
}

interface PendingSubscribe {
  table: string;
  resolve: (result: PqdbResponse<Subscription>) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 32_000;

// ---------------------------------------------------------------------------
// RealtimeClient
// ---------------------------------------------------------------------------

export class RealtimeClient {
  private readonly opts: RealtimeClientOptions;
  private ws: WebSocket | null = null;
  private subscriptions: SubscriptionEntry[] = [];
  private pendingSubscribes: PendingSubscribe[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
  }

  /**
   * Create a subscription builder for a table and event type.
   * Call .subscribe() on the returned object to activate.
   */
  on(
    schema: TableSchema,
    eventType: RealtimeEventType,
    callback: RealtimeCallback,
  ): { subscribe: () => Promise<PqdbResponse<Subscription>> } {
    const entry: SubscriptionEntry = {
      table: schema.name,
      schema,
      eventType,
      callback,
      active: true,
    };

    return {
      subscribe: () => this.addSubscription(entry),
    };
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async addSubscription(
    entry: SubscriptionEntry,
  ): Promise<PqdbResponse<Subscription>> {
    this.subscriptions.push(entry);

    // Ensure WebSocket is connected
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    // Send subscribe message
    return this.sendSubscribe(entry);
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      const wsUrl = this.buildWsUrl();
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.resetHeartbeatTimer();
        resolve();
      };

      this.ws.onmessage = (ev: MessageEvent) => {
        this.handleMessage(ev);
      };

      this.ws.onclose = (ev: CloseEvent) => {
        this.handleClose(ev);
      };

      this.ws.onerror = () => {
        // onclose will fire after onerror
      };
    });
  }

  private buildWsUrl(): string {
    let base = this.opts.baseUrl.replace(/\/+$/, "");
    base = base.replace(/^http:/, "ws:");
    base = base.replace(/^https:/, "wss:");

    let url = `${base}/v1/realtime?apikey=${encodeURIComponent(this.opts.apiKey)}`;
    if (this.opts.token) {
      url += `&token=${encodeURIComponent(this.opts.token)}`;
    }
    return url;
  }

  private sendSubscribe(
    entry: SubscriptionEntry,
  ): Promise<PqdbResponse<Subscription>> {
    return new Promise((resolve) => {
      const table = entry.table;

      // Check if we already have a pending subscribe for this table
      // (e.g., from a reconnect resubscribe that hasn't been acked yet)
      const alreadySubscribed = this.pendingSubscribes.some(
        (p) => p.table === table,
      );

      if (!alreadySubscribed) {
        this.pendingSubscribes.push({ table, resolve });
        this.ws!.send(JSON.stringify({ type: "subscribe", table }));
      } else {
        // Register this resolve but don't send duplicate subscribe
        this.pendingSubscribes.push({ table, resolve });
      }
    });
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }

    const type = msg.type as string;

    if (type === "heartbeat") {
      this.resetHeartbeatTimer();
      return;
    }

    if (type === "ack") {
      this.handleAck(msg);
      return;
    }

    if (type === "error") {
      this.handleError(msg);
      return;
    }

    if (type === "event") {
      this.handleEvent(msg);
      return;
    }
  }

  private handleAck(msg: Record<string, unknown>): void {
    const table = msg.table as string;
    // Successful ack means connection is stable — reset backoff
    this.reconnectAttempt = 0;

    const idx = this.pendingSubscribes.findIndex((p) => p.table === table);
    if (idx === -1) return;

    const pending = this.pendingSubscribes.splice(idx, 1)[0];

    const subscription: Subscription = {
      unsubscribe: () => this.removeSubscription(table),
    };

    pending.resolve({ data: subscription, error: null });
  }

  private handleError(msg: Record<string, unknown>): void {
    const message = msg.message as string;

    // Try to resolve any pending subscribe with an error
    if (this.pendingSubscribes.length > 0) {
      const pending = this.pendingSubscribes.shift()!;
      pending.resolve({
        data: null,
        error: { code: "REALTIME_ERROR", message },
      });
    }
  }

  private handleEvent(msg: Record<string, unknown>): void {
    const table = msg.table as string;
    const rawEvent = (msg.event as string).toLowerCase() as
      | "insert"
      | "update"
      | "delete";
    const row = msg.row as Record<string, unknown>;

    // Find matching subscriptions
    const matching = this.subscriptions.filter(
      (sub) =>
        sub.active &&
        sub.table === table &&
        (sub.eventType === "*" || sub.eventType === rawEvent),
    );

    for (const sub of matching) {
      const shouldDecrypt =
        rawEvent !== "delete" && this.opts.decryptRow !== null;

      if (shouldDecrypt) {
        this.opts.decryptRow!(row, sub.schema).then((decryptedRow) => {
          sub.callback({ event: rawEvent, row: decryptedRow });
        });
      } else {
        sub.callback({ event: rawEvent, row });
      }
    }
  }

  private removeSubscription(table: string): void {
    // Mark all subscriptions for this table as inactive
    this.subscriptions = this.subscriptions.filter(
      (sub) => sub.table !== table,
    );

    // Send unsubscribe if WebSocket is open
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", table }));
    }

    // If no more subscriptions, close the WebSocket
    if (this.subscriptions.length === 0) {
      this.intentionalClose = true;
      this.clearTimers();
      if (this.ws) {
        this.ws.close(1000, "All subscriptions removed");
      }
    }
  }

  private handleClose(_ev: CloseEvent): void {
    this.clearHeartbeatTimer();

    if (this.intentionalClose) {
      this.intentionalClose = false;
      return;
    }

    // Only reconnect if there are active subscriptions
    if (this.subscriptions.length === 0) return;

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      2 ** this.reconnectAttempt * 1000,
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    this.ws = null;
    await this.connect();

    // Resubscribe all active subscriptions
    const tables = new Set(this.subscriptions.map((s) => s.table));
    for (const table of tables) {
      this.ws!.send(JSON.stringify({ type: "subscribe", table }));
    }
  }

  private resetHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      // No heartbeat received within timeout — force reconnect
      if (this.ws) {
        this.ws.close(4000, "Heartbeat timeout");
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeatTimer();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
