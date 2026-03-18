import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Use vi.hoisted to create mock functions that can be referenced in vi.mock factories
const { mockLogin, mockNavigate } = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { login: mockLogin },
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

import { LoginPage } from "~/components/login-page";

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders email and password fields", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("renders a Sign In button", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: /sign in$/i }),
    ).toBeInTheDocument();
  });

  it("renders placeholder OAuth buttons", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: /sign in with google/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in with github/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in with passkey/i }),
    ).toBeInTheDocument();
  });

  it("placeholder OAuth buttons are disabled", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: /sign in with google/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /sign in with github/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /sign in with passkey/i }),
    ).toBeDisabled();
  });

  it("renders a link to signup page", () => {
    render(<LoginPage />);
    expect(screen.getByRole("link", { name: /sign up/i })).toHaveAttribute(
      "href",
      "/signup",
    );
  });

  it("shows validation error for empty email", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    expect(await screen.findByText(/email is required/i)).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("shows validation error for invalid email", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "notanemail");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    expect(
      await screen.findByText(/valid email is required/i),
    ).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("shows validation error for empty password", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    expect(
      await screen.findByText(/password is required/i),
    ).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("calls login and navigates on success", async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      data: {
        access_token: "at",
        refresh_token: "rt",
        token_type: "bearer",
      },
      error: null,
    });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("test@example.com", "password123");
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/projects");
    });
  });

  it("shows 'Invalid credentials' on 401 error", async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      data: null,
      error: { code: 401, message: "Invalid credentials" },
    });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    expect(
      await screen.findByText(/invalid credentials/i),
    ).toBeInTheDocument();
  });

  it("disables submit button while loading", async () => {
    const user = userEvent.setup();
    let resolveLogin: (value: unknown) => void;
    mockLogin.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();

    resolveLogin!({
      data: { access_token: "at", refresh_token: "rt" },
      error: null,
    });
  });
});
