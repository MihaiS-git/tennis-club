// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { FormEvent } from "react";

const { signUpAction, signInAction, forgotPasswordAction, resetPasswordAction, changePasswordAction } = vi.hoisted(() => ({
  signUpAction: vi.fn(),
  signInAction: vi.fn(),
  forgotPasswordAction: vi.fn(),
  resetPasswordAction: vi.fn(),
  changePasswordAction: vi.fn(),
}));

vi.mock("../../src/app/(auth)/actions", () => ({
  signUpAction,
  signInAction,
  forgotPasswordAction,
  resetPasswordAction,
}));
vi.mock("../../src/app/account/actions", () => ({ changePasswordAction }));

import { SignInForm } from "../../src/components/auth/sign-in-form";
import { SignUpForm } from "../../src/components/auth/sign-up-form";
import { ForgotPasswordForm } from "../../src/components/auth/forgot-password-form";
import { ResetPasswordForm } from "../../src/components/auth/reset-password-form";
import { ChangePasswordForm } from "../../src/components/auth/change-password-form";
import { PasswordInput } from "../../src/components/password-input";

beforeEach(() => {
  signUpAction.mockReset();
  signInAction.mockReset();
  forgotPasswordAction.mockReset();
  resetPasswordAction.mockReset();
  changePasswordAction.mockReset();
});
afterEach(cleanup);

it.each([
  ["signin", SignInForm, signInAction, "Sign in"],
  ["signup", SignUpForm, signUpAction, "Sign up"],
  ["recovery", ForgotPasswordForm, forgotPasswordAction, "Send reset link"],
  ["reset", ResetPasswordForm, resetPasswordAction, "Reset password"],
  ["change", ChangePasswordForm, changePasswordAction, "Change password"],
] as const)("preserves %s input entered before hydration through interaction and validation failure", async (_flow, Form, action, submitName) => {
  action.mockResolvedValueOnce({ formError: "Please correct your details.", fieldErrors: { password: "Check your password." } });
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(<Form />);
  const fields = [...container.querySelectorAll("input")];
  const expected = new Map(fields.map((field) => [field.name, field.type === "email" ? "member@example.test" : `${field.name}-before-hydration-123`]));
  // Native editing occurs before React attaches handlers to the server-rendered form.
  for (const field of fields) field.value = expected.get(field.name) ?? "";
  const root = hydrateRoot(container, <Form />);
  try {
    await act(async () => {});
    if (fields.length > 1) {
      const edited = fields[fields.length - 1];
      const value = "Edited after hydration-123";
      fireEvent.change(edited, { target: { value } });
      expected.set(edited.name, value);
      fireEvent.click(within(container).getAllByRole("button", { name: "Show password" })[0]);
      expect(within(container).getByRole("button", { name: "Hide password" })).toBeDefined();
    }
    for (const field of fields) expect(field.value).toBe(expected.get(field.name));
    fireEvent.click(within(container).getByRole("button", { name: submitName }));
    await within(container).findByText("Please correct your details.");
    expect(action).toHaveBeenCalledOnce();
    const submitted: FormData = action.mock.calls[0][1];
    for (const field of fields) {
      expect(submitted.get(field.name)).toBe(expected.get(field.name));
      expect(field.value).toBe(expected.get(field.name));
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

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
