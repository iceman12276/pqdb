import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "~/components/theme-toggle";
import { ThemeProvider } from "~/lib/theme";

function renderWithTheme() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("renders the theme toggle button", () => {
    renderWithTheme();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("defaults to dark theme", () => {
    renderWithTheme();
    // Default is dark, so button label should say "Switch to light theme"
    expect(
      screen.getByLabelText("Switch to light theme"),
    ).toBeInTheDocument();
  });

  it("toggles from dark to light on click", async () => {
    const user = userEvent.setup();
    renderWithTheme();

    const button = screen.getByTestId("theme-toggle");
    await user.click(button);

    expect(
      screen.getByLabelText("Switch to dark theme"),
    ).toBeInTheDocument();
  });

  it("toggles back to dark on second click", async () => {
    const user = userEvent.setup();
    renderWithTheme();

    const button = screen.getByTestId("theme-toggle");
    await user.click(button);
    await user.click(button);

    expect(
      screen.getByLabelText("Switch to light theme"),
    ).toBeInTheDocument();
  });

  it("persists theme to localStorage", async () => {
    const user = userEvent.setup();
    renderWithTheme();

    const button = screen.getByTestId("theme-toggle");
    await user.click(button);

    expect(localStorage.getItem("pqdb-theme")).toBe("light");
  });
});
