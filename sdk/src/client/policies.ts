/**
 * PoliciesClient manages RLS policies for project tables.
 */
import type { HttpClient } from "./http.js";
import type {
  CreatePolicyRequest,
  Policy,
  PqdbResponse,
} from "./types.js";

export class PoliciesClient {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async create(
    tableName: string,
    data: CreatePolicyRequest,
  ): Promise<PqdbResponse<Policy>> {
    return this.http.request<Policy>({
      method: "POST",
      path: `/v1/db/tables/${tableName}/policies`,
      body: data,
    });
  }

  async list(tableName: string): Promise<PqdbResponse<Policy[]>> {
    return this.http.request<Policy[]>({
      method: "GET",
      path: `/v1/db/tables/${tableName}/policies`,
    });
  }

  async delete(
    tableName: string,
    policyId: string,
  ): Promise<PqdbResponse<void>> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/db/tables/${tableName}/policies/${policyId}`,
    });
  }
}
