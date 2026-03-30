/**
 * Webhook API functions for the Dashboard.
 * Calls the project-scoped /v1/db/webhooks endpoints via the authenticated API client.
 */

import { api } from "./api-client";

export interface Webhook {
  id: number;
  table_name: string;
  events: string[];
  url: string;
  active: boolean;
  created_at: string | null;
}

export interface CreateWebhookData {
  table_name: string;
  events: string[];
  url: string;
  secret?: string;
}

/**
 * Fetch all webhooks (GET /v1/db/webhooks).
 * Requires a service_role API key.
 */
export async function fetchWebhooks(apiKey: string): Promise<Webhook[]> {
  const result = await api.fetch("/v1/db/webhooks", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch webhooks");
  }
  return result.data as Webhook[];
}

/**
 * Create a webhook (POST /v1/db/webhooks).
 * Requires a service_role API key.
 */
export async function createWebhook(
  apiKey: string,
  data: CreateWebhookData,
): Promise<Webhook> {
  const result = await api.fetch("/v1/db/webhooks", {
    method: "POST",
    headers: {
      apikey: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!result.ok) {
    throw new Error("Failed to create webhook");
  }
  return result.data as Webhook;
}

/**
 * Delete a webhook (DELETE /v1/db/webhooks/:id).
 * Requires a service_role API key.
 */
export async function deleteWebhook(
  apiKey: string,
  id: number,
): Promise<void> {
  const result = await api.fetch(`/v1/db/webhooks/${id}`, {
    method: "DELETE",
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to delete webhook");
  }
}
