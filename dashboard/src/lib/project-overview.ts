/**
 * Project overview and audit log API functions.
 */

import { api } from "./api-client";

export interface ProjectOverview {
  project_id: string;
  name: string;
  status: string;
  region: string;
  database_name: string | null;
  created_at: string;
  encryption: string;
  tables_count: number;
  auth_users_count: number;
  rls_policies_count: number;
  database_requests: number;
  auth_requests: number;
  realtime_requests: number;
  mcp_requests: number;
}

export interface AuditLogEntry {
  id: string;
  event_type: string;
  method: string;
  path: string;
  status_code: number;
  project_id: string;
  user_id: string | null;
  ip_address: string;
  created_at: string | null;
}

export interface AuditLogResponse {
  data: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface LogFilters {
  event_type?: string;
  status_code?: number;
  start_time?: string;
  end_time?: string;
  limit?: number;
  offset?: number;
}

export async function fetchProjectOverview(
  projectId: string,
): Promise<ProjectOverview> {
  const result = await api.fetch(`/v1/projects/${projectId}/overview`);
  if (!result.ok) {
    throw new Error("Failed to fetch project overview");
  }
  return result.data as ProjectOverview;
}

export async function fetchProjectLogs(
  projectId: string,
  filters?: LogFilters,
): Promise<AuditLogResponse> {
  const params = new URLSearchParams();
  if (filters?.event_type) params.set("event_type", filters.event_type);
  if (filters?.status_code != null)
    params.set("status_code", String(filters.status_code));
  if (filters?.start_time) params.set("start_time", filters.start_time);
  if (filters?.end_time) params.set("end_time", filters.end_time);
  if (filters?.limit != null) params.set("limit", String(filters.limit));
  if (filters?.offset != null) params.set("offset", String(filters.offset));

  const qs = params.toString();
  const path = `/v1/projects/${projectId}/logs${qs ? `?${qs}` : ""}`;
  const result = await api.fetch(path);
  if (!result.ok) {
    throw new Error("Failed to fetch project logs");
  }
  return result.data as AuditLogResponse;
}
