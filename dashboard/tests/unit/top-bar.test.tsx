import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "~/lib/theme";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchProjects, mockNavigate } = vi.hoisted(() => ({
  mockFetchProjects: vi.fn().mockResolvedValue([]),
  mockNavigate: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  fetchProjects: mockFetchProjects,
  fetchProjectKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
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
  it("renders the top bar", () => {
    renderWithTheme();
    expect(screen.getByTestId("top-bar")).toBeInTheDocument();
  });

  it("renders the Account selector", () => {
    renderWithTheme();
    expect(screen.getByText("Account")).toBeInTheDocument();
  });

  it("renders the Project selector dropdown", () => {
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
});
