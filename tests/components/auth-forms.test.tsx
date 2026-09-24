// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormEvent } from "react";

const { signUpAction, signInAction } = vi.hoisted(() => ({
  signUpAction: vi.fn(),
  signInAction: vi.fn(),
}));

vi.mock("../../src/app/(auth)/actions", () => ({
  signUpAction,
  signInAction,
  forgotPasswordAction: vi.fn(),
  resetPasswordAction: vi.fn(),
}));
vi.mock("../../src/app/account/actions", () => ({ changePasswordAction: vi.fn() }));

import { SignInForm } from "../../src/components/auth/sign-in-form";
import { SignUpForm } from "../../src/components/auth/sign-up-form";
import { ResetPasswordForm } from "../../src/components/auth/reset-password-form";
import { ChangePasswordForm } from "../../src/components/auth/change-password-form";
import { PasswordInput } from "../../src/components/password-input";

beforeEach(() => {
  signUpAction.mockReset();
  signInAction.mockReset();
});
afterEach(cleanup);

it("submits sign-in credentials without a next field", async () => {
  signInAction.mockResolvedValueOnce({});
  render(<SignInForm />);

  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
    target: { value: "member@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), {
    target: { value: "password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await waitFor(() => expect(signInAction).toHaveBeenCalledOnce());
  const submitted = signInAction.mock.calls[0][1] as FormData;
  expect(submitted.get("email")).toBe("member@example.com");
  expect(submitted.get("password")).toBe("password-123");
  expect(submitted.has("next")).toBe(false);
});

it("editing the sign-in email clears only its field error", async () => {
  signInAction.mockResolvedValueOnce({
    fieldErrors: {
      email: "Enter a valid email address.",
      password: "Enter your password.",
    },
  });
  render(<SignInForm />);

  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);
  expect(await screen.findByText("Enter a valid email address.")).toBeDefined();
  expect(screen.getByText("Enter your password.")).toBeDefined();

  const email = screen.getByRole("textbox", { name: "Email" });
  fireEvent.change(email, { target: { value: "member@example.com" } });

  expect(screen.queryByText("Enter a valid email address.")).toBeNull();
  expect(screen.getByText("Enter your password.")).toBeDefined();
});

it("editing the sign-in password clears only its field error", async () => {
  signInAction.mockResolvedValueOnce({
    fieldErrors: {
      email: "Enter a valid email address.",
      password: "Enter your password.",
    },
  });
  render(<SignInForm />);

  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);
  expect(await screen.findByText("Enter your password.")).toBeDefined();
  expect(screen.getByText("Enter a valid email address.")).toBeDefined();

  const password = screen.getByLabelText("Password", { selector: "input" });
  fireEvent.change(password, { target: { value: "password-123" } });

  expect(screen.queryByText("Enter your password.")).toBeNull();
  expect(screen.getByText("Enter a valid email address.")).toBeDefined();
});

it("focuses the first invalid sign-in field after a failed submission", async () => {
  signInAction.mockResolvedValueOnce({
    fieldErrors: {
      email: "Enter a valid email address.",
      password: "Enter your password.",
    },
  });
  render(<SignInForm />);

  const submit = screen.getByRole("button", { name: "Sign in" });
  submit.focus();
  fireEvent.submit(submit.closest("form")!);

  const email = screen.getByRole("textbox", { name: "Email" });
  await waitFor(() => expect(document.activeElement).toBe(email));
  expect(email.getAttribute("aria-invalid")).toBe("true");
  expect(email.getAttribute("aria-describedby")).toBe("signin-email-error");
  expect(document.getElementById("signin-email-error")?.textContent).toBe("Enter a valid email address.");
});

it("focuses the password when it is the only invalid sign-in field", async () => {
  signInAction.mockResolvedValueOnce({ fieldErrors: { password: "Enter your password." } });
  render(<SignInForm />);

  const submit = screen.getByRole("button", { name: "Sign in" });
  submit.focus();
  fireEvent.submit(submit.closest("form")!);

  const password = screen.getByLabelText("Password", { selector: "input" });
  await waitFor(() => expect(document.activeElement).toBe(password));
});

it("does not move focus on a form-only error", async () => {
  signInAction.mockResolvedValueOnce({ formError: "Please try again." });
  render(<SignInForm />);

  const submit = screen.getByRole("button", { name: "Sign in" });
  submit.focus();
  fireEvent.submit(submit.closest("form")!);

  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Please try again.");
  expect(document.activeElement).toBe(submit);
});

it("toggles password visibility without submitting and keeps focus on the input", () => {
  const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <PasswordInput aria-label="Password" />
    </form>,
  );

  const input = screen.getByLabelText("Password", { selector: "input" });
  const show = screen.getByRole("button", { name: "Show password" });
  expect(input.getAttribute("type")).toBe("password");
  expect(show.getAttribute("type")).toBe("button");

  fireEvent.click(show);
  expect(input.getAttribute("type")).toBe("text");
  expect(document.activeElement).toBe(input);

  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(input.getAttribute("type")).toBe("password");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("renders inline signup errors and clears only affected stale errors as fields change", async () => {
  signUpAction.mockResolvedValueOnce({
    formError: "Please correct the highlighted fields.",
    fieldErrors: {
      email: "Enter a valid email address.",
      password: "Use at least 15 characters.",
      confirmPassword: "Passwords do not match.",
    },
  });
  render(<SignUpForm />);

  fireEvent.submit(screen.getByRole("button", { name: "Sign up" }).closest("form")!);
  expect(await screen.findByText("Enter a valid email address.")).toBeDefined();
  expect(screen.getByText("Use at least 15 characters.")).toBeDefined();
  expect(screen.getByText("Passwords do not match.")).toBeDefined();

  const email = screen.getByRole("textbox", { name: "Email" });
  const password = screen.getByLabelText("New password", { selector: "input" });

  fireEvent.change(email, { target: { value: "member@example.com" } });
  expect(screen.queryByText("Enter a valid email address.")).toBeNull();
  expect(screen.getByText("Use at least 15 characters.")).toBeDefined();
  expect(screen.getByText("Passwords do not match.")).toBeDefined();
  expect(screen.queryByText("Please correct the highlighted fields.")).toBeNull();

  fireEvent.change(password, { target: { value: "corrected-password" } });
  expect(screen.queryByText("Use at least 15 characters.")).toBeNull();
  expect(screen.queryByText("Passwords do not match.")).toBeNull();
});

it.each([
  ["signup", SignUpForm],
  ["reset", ResetPasswordForm],
  ["change", ChangePasswordForm],
])("uses shared new-password fields in %s", (_flow, Form) => {
  render(<Form />);
  const password = screen.getByLabelText("New password", { selector: "input" });
  const confirmation = screen.getByLabelText("Confirm new password", { selector: "input" });
  const descriptionIds = password.getAttribute("aria-describedby")?.split(" ") ?? [];
  expect(descriptionIds.some((id) => document.getElementById(id)?.textContent?.includes("15"))).toBe(true);
  expect(password.getAttribute("autocomplete")).toBe("new-password");
  expect(confirmation.getAttribute("autocomplete")).toBe("new-password");
  expect(descriptionIds).toHaveLength(1);
  if (_flow === "change") expect(screen.getByLabelText("Current password", { selector: "input" })).toBeDefined();
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

  finishAction?.({});
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Sign up" }).hasAttribute("disabled")).toBe(false);
  });
});
