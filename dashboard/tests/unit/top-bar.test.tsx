import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopBar } from "~/components/top-bar";
import { ThemeProvider } from "~/lib/theme";

function renderWithTheme() {
  return render(
    <ThemeProvider>
      <TopBar />
    </ThemeProvider>,
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

  it("renders the Project selector", () => {
    renderWithTheme();
    expect(screen.getByText("Project")).toBeInTheDocument();
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
