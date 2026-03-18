import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockSignup, mockNavigate } = vi.hoisted(() => ({
  mockSignup: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { signup: mockSignup },
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

import { SignupPage } from "~/components/signup-page";

describe("SignupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders email and password fields", () => {
    render(<SignupPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("renders a Create Account button", () => {
    render(<SignupPage />);
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
  });

  it("renders a link to login page", () => {
    render(<SignupPage />);
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("shows validation error for empty email", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/email is required/i)).toBeInTheDocument();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it("shows validation error for short password", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      await screen.findByText(/password must be at least 8 characters/i),
    ).toBeInTheDocument();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it("calls signup and navigates on success", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: {
        access_token: "at",
        refresh_token: "rt",
        token_type: "bearer",
      },
      error: null,
    });

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledWith(
        "test@example.com",
        "password123",
      );
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/projects" });
    });
  });

  it("shows 'Email already registered' on 409 error", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: null,
      error: { code: 409, message: "Email already registered" },
    });

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      await screen.findByText(/email already registered/i),
    ).toBeInTheDocument();
  });

  it("disables submit button while loading", async () => {
    const user = userEvent.setup();
    let resolveSignup: (value: unknown) => void;
    mockSignup.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignup = resolve;
      }),
    );

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      screen.getByRole("button", { name: /creating account/i }),
    ).toBeDisabled();

    resolveSignup!({
      data: { access_token: "at", refresh_token: "rt" },
      error: null,
    });
  });
});
