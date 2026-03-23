import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { mockFetchProject, mockFetchServiceKey } = vi.hoisted(() => ({
  mockFetchProject: vi.fn(),
  mockFetchServiceKey: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  fetchProject: mockFetchProject,
  fetchServiceKey: mockFetchServiceKey,
}));

import { ProjectProvider, useProjectContext } from "~/lib/project-context";

function TestConsumer() {
  const { project, apiKey, loading, error } = useProjectContext();
  return (
    <div>
      <span data-testid="loading">{loading ? "true" : "false"}</span>
      <span data-testid="apiKey">{apiKey ?? "none"}</span>
      <span data-testid="project">{project?.name ?? "none"}</span>
      <span data-testid="error">{error ?? "none"}</span>
    </div>
  );
}

describe("ProjectContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    // Mock global fetch for the introspect validation call in project-context.tsx
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    );
  });

  it("starts in loading state", () => {
    mockFetchProject.mockReturnValue(new Promise(() => {}));
    mockFetchServiceKey.mockReturnValue(new Promise(() => {}));

    render(
      <ProjectProvider projectId="p1">
        <TestConsumer />
      </ProjectProvider>,
    );
    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    expect(screen.getByTestId("apiKey")).toHaveTextContent("none");
    expect(screen.getByTestId("project")).toHaveTextContent("none");
  });

  it("loads project and service key on mount", async () => {
    mockFetchProject.mockResolvedValueOnce({
      id: "p1",
      name: "My Project",
      region: "us-east-1",
      status: "active",
      database_name: "pqdb_project_p1",
      created_at: "2026-01-01T00:00:00Z",
    });
    mockFetchServiceKey.mockResolvedValueOnce({
      id: "key-1",
      role: "service",
      key: "pqdb_service_abc12345678901234567890",
      key_prefix: "pqdb_ser",
    });

    render(
      <ProjectProvider projectId="p1">
        <TestConsumer />
      </ProjectProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("false");
    });
    expect(screen.getByTestId("apiKey")).toHaveTextContent(
      "pqdb_service_abc12345678901234567890",
    );
    expect(screen.getByTestId("project")).toHaveTextContent("My Project");
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });

  it("sets error when fetch fails", async () => {
    mockFetchProject.mockRejectedValueOnce(new Error("Network error"));
    mockFetchServiceKey.mockRejectedValueOnce(new Error("Network error"));

    render(
      <ProjectProvider projectId="p1">
        <TestConsumer />
      </ProjectProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("false");
    });
    expect(screen.getByTestId("error")).toHaveTextContent("Network error");
    expect(screen.getByTestId("apiKey")).toHaveTextContent("none");
    expect(screen.getByTestId("project")).toHaveTextContent("none");
  });

  it("provides default values outside provider", () => {
    render(<TestConsumer />);
    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    expect(screen.getByTestId("apiKey")).toHaveTextContent("none");
  });

  it("calls fetchProject and fetchServiceKey with correct projectId", async () => {
    mockFetchProject.mockResolvedValueOnce({
      id: "p42",
      name: "Test",
      region: "us-east-1",
      status: "active",
      database_name: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    mockFetchServiceKey.mockResolvedValueOnce({
      id: "key-2",
      role: "service",
      key: "pqdb_service_xyz",
      key_prefix: "pqdb_ser",
    });

    render(
      <ProjectProvider projectId="p42">
        <TestConsumer />
      </ProjectProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("false");
    });
    expect(mockFetchProject).toHaveBeenCalledWith("p42");
    expect(mockFetchServiceKey).toHaveBeenCalledWith("p42");
  });

  describe("service key caching", () => {
    const SERVICE_KEY_PREFIX = "pqdb_service_key_";
    const FAKE_PROJECT = {
      id: "p1",
      name: "My Project",
      region: "us-east-1",
      status: "active",
      database_name: "pqdb_project_p1",
      created_at: "2026-01-01T00:00:00Z",
    };
    const FAKE_KEY = "pqdb_service_abc12345678901234567890";

    it("caches service key in sessionStorage after first fetch", async () => {
      mockFetchProject.mockResolvedValueOnce(FAKE_PROJECT);
      mockFetchServiceKey.mockResolvedValueOnce({
        id: "key-1",
        role: "service",
        key: FAKE_KEY,
        key_prefix: "pqdb_ser",
      });

      render(
        <ProjectProvider projectId="p1">
          <TestConsumer />
        </ProjectProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
      });
      expect(sessionStorage.getItem(SERVICE_KEY_PREFIX + "p1")).toBe(FAKE_KEY);
    });

    it("uses cached key from sessionStorage instead of calling fetchServiceKey", async () => {
      sessionStorage.setItem(SERVICE_KEY_PREFIX + "p1", "pqdb_service_cached_key");
      mockFetchProject.mockResolvedValueOnce(FAKE_PROJECT);

      render(
        <ProjectProvider projectId="p1">
          <TestConsumer />
        </ProjectProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
      });
      expect(mockFetchServiceKey).not.toHaveBeenCalled();
      expect(screen.getByTestId("apiKey")).toHaveTextContent("pqdb_service_cached_key");
    });

    it("uses separate cache keys per project", async () => {
      sessionStorage.setItem(SERVICE_KEY_PREFIX + "p1", "pqdb_service_cached_key");
      mockFetchProject.mockResolvedValueOnce({ ...FAKE_PROJECT, id: "p2" });
      mockFetchServiceKey.mockResolvedValueOnce({
        id: "key-2",
        role: "service",
        key: "pqdb_service_new_key",
        key_prefix: "pqdb_ser",
      });

      render(
        <ProjectProvider projectId="p2">
          <TestConsumer />
        </ProjectProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
      });
      expect(mockFetchServiceKey).toHaveBeenCalledWith("p2");
      expect(screen.getByTestId("apiKey")).toHaveTextContent("pqdb_service_new_key");
      expect(sessionStorage.getItem(SERVICE_KEY_PREFIX + "p2")).toBe("pqdb_service_new_key");
    });
  });
});
