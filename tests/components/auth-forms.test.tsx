// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { signUpAction } = vi.hoisted(() => ({ signUpAction: vi.fn() }));

vi.mock("../../src/app/(auth)/actions", () => ({
  signUpAction,
  signInAction: vi.fn(),
  forgotPasswordAction: vi.fn(),
  resetPasswordAction: vi.fn(),
}));
vi.mock("../../src/app/account/actions", () => ({ changePasswordAction: vi.fn() }));

import { SignUpForm } from "../../src/components/auth-action-forms";
import { PasswordInput } from "../../src/components/password-input";

beforeEach(() => {
  signUpAction.mockReset();
});
afterEach(cleanup);

it("toggles password visibility without submitting and keeps focus on the input", () => {
  render(<PasswordInput aria-label="Password" />);

  const input = screen.getByLabelText("Password", { selector: "input" });
  const show = screen.getByRole("button", { name: "Show password" });
  expect(input.getAttribute("type")).toBe("password");
  expect(show.getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(show);
  expect(input.getAttribute("type")).toBe("text");
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(input.getAttribute("type")).toBe("password");
  expect(screen.getByRole("button", { name: "Show password" }).getAttribute("aria-pressed")).toBe("false");
});

it("renders inline signup errors and clears only affected stale errors as fields change", async () => {
  signUpAction.mockResolvedValueOnce({
    formError: "Please correct the highlighted fields.",
    fieldErrors: {
      email: "Enter a valid email address.",
      password: "Password must be at least 6 characters long.",
      confirmPassword: "Passwords do not match.",
    },
  });
  render(<SignUpForm />);

  fireEvent.submit(screen.getByRole("button", { name: "Sign up" }).closest("form")!);
  expect(await screen.findByText("Enter a valid email address.")).toBeDefined();
  expect(screen.getByText("Password must be at least 6 characters long.")).toBeDefined();
  expect(screen.getByText("Passwords do not match.")).toBeDefined();

  const email = screen.getByRole("textbox", { name: "Email" });
  const password = screen.getByLabelText("Password", { selector: "input" });
  const confirmation = screen.getByLabelText("Confirm password", { selector: "input" });
  expect(email.getAttribute("aria-invalid")).toBe("true");
  expect(email.getAttribute("aria-describedby")).toBe("signup-email-error");
  expect(password.getAttribute("aria-invalid")).toBe("true");
  expect(confirmation.getAttribute("aria-invalid")).toBe("true");

  fireEvent.change(email, { target: { value: "member@example.com" } });
  expect(screen.queryByText("Enter a valid email address.")).toBeNull();
  expect(email.getAttribute("aria-invalid")).toBe("false");
  expect(screen.getByText("Password must be at least 6 characters long.")).toBeDefined();
  expect(screen.getByText("Passwords do not match.")).toBeDefined();
  expect(screen.queryByText("Please correct the highlighted fields.")).toBeNull();

  fireEvent.change(password, { target: { value: "corrected-password" } });
  expect(screen.queryByText("Password must be at least 6 characters long.")).toBeNull();
  expect(screen.queryByText("Passwords do not match.")).toBeNull();
  expect(password.getAttribute("aria-invalid")).toBe("false");
  expect(confirmation.getAttribute("aria-invalid")).toBe("false");
});

it("disables signup submission and shows its pending label while the action is running", async () => {
  let finishAction: ((value: object) => void) | undefined;
  signUpAction.mockImplementationOnce(() => new Promise((resolve) => {
    finishAction = resolve;
  }));
  render(<SignUpForm />);

  const form = screen.getByRole("button", { name: "Sign up" }).closest("form")!;
  fireEvent.submit(form);
  const pending = await screen.findByRole("button", { name: "Creating account…" });
  expect(pending.hasAttribute("disabled")).toBe(true);
  expect(pending.getAttribute("aria-disabled")).toBe("true");

  finishAction?.({});
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Sign up" }).hasAttribute("disabled")).toBe(false);
  });
});
