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

import { ProjectList } from "~/components/project-list";

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
    status: "provisioning",
    database_name: null,
    created_at: "2026-02-20T14:30:00Z",
  },
];

describe("ProjectList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton while fetching", () => {
    mockFetchProjects.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ProjectList />);
    expect(screen.getByTestId("project-list-loading")).toBeInTheDocument();
  });

  it("renders project cards after loading", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    render(<ProjectList />);

    expect(await screen.findByText("My App")).toBeInTheDocument();
    expect(screen.getByText("Test Project")).toBeInTheDocument();
  });

  it("shows status badge for each project", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    render(<ProjectList />);

    expect(await screen.findByText("active")).toBeInTheDocument();
    expect(screen.getByText("provisioning")).toBeInTheDocument();
  });

  it("shows region for each project", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    render(<ProjectList />);

    expect(await screen.findByText("us-east-1")).toBeInTheDocument();
    expect(screen.getByText("eu-west-1")).toBeInTheDocument();
  });

  it("shows created date for each project", async () => {
    mockFetchProjects.mockResolvedValueOnce(mockProjects);
    render(<ProjectList />);

    // Should display formatted date
    await waitFor(() => {
      expect(screen.getByText(/Jan 15, 2026/)).toBeInTheDocument();
    });
  });

  it("shows empty state when no projects exist", async () => {
    mockFetchProjects.mockResolvedValueOnce([]);
    render(<ProjectList />);

    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("renders Create Project button", async () => {
    mockFetchProjects.mockResolvedValueOnce([]);
    render(<ProjectList />);

    expect(
      await screen.findByRole("button", { name: /create project/i }),
    ).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchProjects.mockRejectedValueOnce(new Error("Failed to load projects"));
    render(<ProjectList />);

    expect(await screen.findByText(/failed to load projects/i)).toBeInTheDocument();
  });
});
