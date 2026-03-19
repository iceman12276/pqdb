import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

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
    const { wrapper } = createQueryWrapper();
    render(
      <ProjectSelector
        selectedProjectId={null}
        onProjectSelect={vi.fn()}
      />,
      { wrapper },
    );

    expect(screen.getByTestId("project-selector")).toBeInTheDocument();
  });

  it("shows 'Select project' when none selected", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    const { wrapper } = createQueryWrapper();
    render(
      <ProjectSelector
        selectedProjectId={null}
        onProjectSelect={vi.fn()}
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText(/select project/i)).toBeInTheDocument();
    });
  });

  it("shows selected project name", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    const { wrapper } = createQueryWrapper();
    render(
      <ProjectSelector
        selectedProjectId="p1"
        onProjectSelect={vi.fn()}
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText("My App")).toBeInTheDocument();
    });
  });

  it("calls onProjectSelect when a project is chosen", async () => {
    const user = userEvent.setup();
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    const onSelect = vi.fn();
    const { wrapper } = createQueryWrapper();

    render(
      <ProjectSelector
        selectedProjectId={null}
        onProjectSelect={onSelect}
      />,
      { wrapper },
    );

    // Wait for projects to load
    await waitFor(() => {
      expect(mockFetchProjects).toHaveBeenCalled();
    });

    // Click the selector to open dropdown — wait for data to be available
    const button = await screen.findByRole("button", { name: /select project/i });
    await user.click(button);

    // Click on a project option in the dropdown
    const option = await screen.findByText("My App");
    await user.click(option);

    expect(onSelect).toHaveBeenCalledWith(mockProjects[0]);
  });
});
