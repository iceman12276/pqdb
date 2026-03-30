/**
 * Advisor API functions for performance endpoints.
 * Calls GET /v1/db/advisor/* via the authenticated API client with project apikey header.
 */

import { api } from "./api-client";

export interface PerformanceFinding {
  rule_id: string;
  severity: "warning" | "info";
  category: string;
  title: string;
  message: string;
  table: string;
  suggestion: string;
}

export async function fetchPerformanceFindings(
  apiKey: string,
): Promise<PerformanceFinding[]> {
  const result = await api.fetch("/v1/db/advisor/performance", {
    headers: { apikey: apiKey },
  });
  if (!result.ok) {
    throw new Error("Failed to fetch performance findings");
  }
  return result.data as PerformanceFinding[];
}
