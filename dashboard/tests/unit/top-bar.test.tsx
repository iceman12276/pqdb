import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "~/lib/theme";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchProjects, mockNavigate, mockUseParams, mockFetchProject } = vi.hoisted(() => ({
  mockFetchProjects: vi.fn().mockResolvedValue([]),
  mockNavigate: vi.fn(),
  mockUseParams: vi.fn().mockReturnValue({}),
  mockFetchProject: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  fetchProjects: mockFetchProjects,
  fetchProject: mockFetchProject,
  fetchProjectKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: (...args: unknown[]) => mockUseParams(...args),
  Link: ({
    to,
    params,
    children,
    className,
    onClick,
    ...rest
  }: {
    to?: string;
    params?: Record<string, string>;
    children: React.ReactNode;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
    [key: string]: unknown;
  }) => {
    // Substitute :paramName patterns from params object
    let href = to ?? "";
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        href = href.replace(`$${key}`, value).replace(`:${key}`, value);
      }
    }
    return (
      <a href={href} className={className} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  },
}));

import { TopBar } from "~/components/top-bar";

function renderWithTheme() {
  const { wrapper: QueryWrapper } = createQueryWrapper();
  return render(
    <QueryWrapper>
      <ThemeProvider>
        <TopBar />
      </ThemeProvider>
    </QueryWrapper>,
  );
}

describe("TopBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchProjects.mockResolvedValue([]);
    mockUseParams.mockReturnValue({});
    mockFetchProject.mockReset();
  });

  it("renders the top bar", () => {
    renderWithTheme();
    expect(screen.getByTestId("top-bar")).toBeInTheDocument();
  });

  it("renders the Account selector", () => {
    renderWithTheme();
    expect(screen.getByText("Account")).toBeInTheDocument();
  });

  it("renders the Project selector dropdown when not inside a project", () => {
    mockUseParams.mockReturnValue({});
    renderWithTheme();
    expect(screen.getByTestId("project-selector")).toBeInTheDocument();
  });

  it("renders the Connect button", () => {
    renderWithTheme();
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  it("renders the search button with Cmd+K label", () => {
    renderWithTheme();
    expect(screen.getByLabelText("Search (Cmd+K)")).toBeInTheDocument();
  });

  it("renders the settings button", () => {
    renderWithTheme();
    expect(screen.getByLabelText("Settings")).toBeInTheDocument();
  });

  it("renders the theme toggle", () => {
    renderWithTheme();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  describe("breadcrumb inside a project (US-009)", () => {
    beforeEach(() => {
      mockUseParams.mockReturnValue({ projectId: "proj-abc" });
      mockFetchProjects.mockResolvedValue([
        {
          id: "proj-abc",
          name: "Acme API",
          region: "us-east-1",
          status: "active",
          database_name: "pqdb_project_proj_abc",
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);
      mockFetchProject.mockResolvedValue({
        id: "proj-abc",
        name: "Acme API",
        region: "us-east-1",
        status: "active",
        database_name: "pqdb_project_proj_abc",
        created_at: "2026-01-01T00:00:00Z",
      });
    });

    it("renders 'All projects' as a clickable Link to /projects", async () => {
      renderWithTheme();
      const link = await screen.findByTestId("breadcrumb-all-projects");
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "/projects");
      expect(link.textContent).toContain("All projects");
    });

    it("renders {ProjectName} as a clickable Link to /projects/{id}", async () => {
      renderWithTheme();
      const link = await screen.findByTestId("breadcrumb-project-name");
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "/projects/proj-abc");
      // Wait for the project name to resolve from the query
      const { waitFor } = await import("@testing-library/react");
      await waitFor(() => {
        expect(link.textContent).toContain("Acme API");
      });
    });

    it("breadcrumb order is Account / All projects / {ProjectName} / {Branch}", async () => {
      renderWithTheme();
      const account = screen.getByText("Account");
      const allProjects = await screen.findByTestId("breadcrumb-all-projects");
      const projectName = await screen.findByTestId("breadcrumb-project-name");

      const accountPos = account.compareDocumentPosition(allProjects);
      expect(accountPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const allProjectsPos = allProjects.compareDocumentPosition(projectName);
      expect(allProjectsPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
