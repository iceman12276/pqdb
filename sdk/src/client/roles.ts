/**
 * RolesClient manages custom roles for a project.
 *
 * Requires developer JWT auth and a projectId.
 */
import type { HttpClient } from "./http.js";
import type {
  CreateRoleRequest,
  Role,
  PqdbResponse,
} from "./types.js";

export class RolesClient {
  private readonly http: HttpClient;
  private readonly projectId: string;

  constructor(http: HttpClient, projectId: string) {
    this.http = http;
    this.projectId = projectId;
  }

  async create(data: CreateRoleRequest): Promise<PqdbResponse<Role>> {
    return this.http.request<Role>({
      method: "POST",
      path: `/v1/projects/${this.projectId}/auth/roles`,
      body: data,
    });
  }

  async list(): Promise<PqdbResponse<Role[]>> {
    return this.http.request<Role[]>({
      method: "GET",
      path: `/v1/projects/${this.projectId}/auth/roles`,
    });
  }

  async delete(name: string): Promise<PqdbResponse<void>> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/projects/${this.projectId}/auth/roles/${name}`,
    });
  }
}
