import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockFetchProjects, mockNavigate } = vi.hoisted(() => ({
  mockFetchProjects: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  fetchProjects: mockFetchProjects,
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

import { ProjectSelector } from "~/components/project-selector";

const mockProjects = [
  {
    id: "p1",
    name: "My App",
    region: "us-east-1",
    status: "active",
    database_name: "pqdb_project_p1",
    created_at: "2026-01-15T10:00:00Z",
  },
  {
    id: "p2",
    name: "Test Project",
    region: "eu-west-1",
    status: "active",
    database_name: "pqdb_project_p2",
    created_at: "2026-02-20T14:30:00Z",
  },
];

describe("ProjectSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the selector button", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    render(
      <ProjectSelector
        selectedProjectId={null}
        onProjectSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("project-selector")).toBeInTheDocument();
  });

  it("shows 'Select project' when none selected", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    render(
      <ProjectSelector
        selectedProjectId={null}
        onProjectSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/select project/i)).toBeInTheDocument();
    });
  });

  it("shows selected project name", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    render(
      <ProjectSelector
        selectedProjectId="p1"
        onProjectSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("My App")).toBeInTheDocument();
    });
  });

  it("calls onProjectSelect when a project is chosen", async () => {
    const user = userEvent.setup();
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    const onSelect = vi.fn();

    render(
      <ProjectSelector
        selectedProjectId={null}
        onProjectSelect={onSelect}
      />,
    );

    // Wait for projects to load by checking that the button renders
    const button = await screen.findByRole("button", { name: /select project/i });

    // Wait for the async fetch to resolve so projects are populated
    await waitFor(() => {
      expect(mockFetchProjects).toHaveBeenCalled();
    });

    // Small delay for state update after fetch resolves
    await new Promise((r) => setTimeout(r, 10));

    // Click the selector to open dropdown
    await user.click(button);

    // Click on a project option in the dropdown
    const option = await screen.findByText("My App");
    await user.click(option);

    expect(onSelect).toHaveBeenCalledWith(mockProjects[0]);
  });
});
