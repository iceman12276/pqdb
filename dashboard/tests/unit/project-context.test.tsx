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
    vi.clearAllMocks();
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
});
