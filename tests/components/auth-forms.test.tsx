// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { FormEvent } from "react";

const { signUpAction, signInAction, forgotPasswordAction, resetPasswordAction, changePasswordAction, resendConfirmationAction } = vi.hoisted(() => ({
  resendConfirmationAction: vi.fn(),
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
  resendConfirmationAction,
}));
vi.mock("../../src/app/account/actions", () => ({ changePasswordAction }));

import { SignInForm } from "../../src/components/auth/sign-in-form";
import { SignUpForm } from "../../src/components/auth/sign-up-form";
import { ChangePasswordForm } from "../../src/components/auth/change-password-form";
import { PasswordInput } from "../../src/components/password-input";
import { ResendConfirmation } from "../../src/components/auth/resend-confirmation";
import { CONFIRMATION_RESEND_SUCCESS } from "../../src/lib/auth/confirmation";

beforeEach(() => {
  signUpAction.mockReset();
  signInAction.mockReset();
  forgotPasswordAction.mockReset();
  resetPasswordAction.mockReset();
  changePasswordAction.mockReset();
  resendConfirmationAction.mockReset();
});
afterEach(cleanup);

it("resends the entered login email without submitting or clearing credentials", async () => {
  signInAction.mockResolvedValue({ formError: "Confirm your email address before signing in.", emailUnconfirmed: true });
  let finish!: (state: { success: string }) => void;
  resendConfirmationAction.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<SignInForm />);
  const email = screen.getByRole("textbox", { name: "Email" });
  const password = screen.getByLabelText("Password", { selector: "input" });
  fireEvent.change(email, { target: { value: "member@example.com" } });
  fireEvent.change(password, { target: { value: "retained password" } });
  expect(screen.queryByRole("button", { name: "Resend confirmation email" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  const resend = await screen.findByRole("button", { name: "Resend confirmation email" });
  fireEvent.click(resend);
  expect(resend.hasAttribute("disabled")).toBe(true);
  expect(resendConfirmationAction).toHaveBeenCalledOnce();
  const submitted: FormData = resendConfirmationAction.mock.calls[0][1];
  expect(submitted.get("email")).toBe("member@example.com");
  expect(submitted.has("password")).toBe(false);
  await act(async () => finish({ success: CONFIRMATION_RESEND_SUCCESS }));
  expect(await screen.findByRole("status")).toBeDefined();
  expect((email as HTMLInputElement).value).toBe("member@example.com");
  expect((password as HTMLInputElement).value).toBe("retained password");
  fireEvent.click(screen.getByRole("button", { name: "Resend confirmation email" }));
  expect(resendConfirmationAction).toHaveBeenCalledOnce();
  expect(signInAction).toHaveBeenCalledOnce();
});

it("does not offer resend for incorrect login credentials", async () => {
  signInAction.mockResolvedValue({ formError: "Email or password is incorrect." });
  render(<SignInForm />);
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);
  await screen.findByText("Email or password is incorrect.");
  expect(screen.queryByRole("button", { name: "Resend confirmation email" })).toBeNull();
});

it("uses the retained signup email, displays rate-limit feedback, and allows retry after cooldown", async () => {
  vi.useFakeTimers();
  try {
    resendConfirmationAction.mockResolvedValue({ formError: "Too many email requests. Please wait a few minutes before trying again." });
    render(<ResendConfirmation email="signup@example.com" />);
    const button = screen.getByRole("button", { name: "Resend confirmation email" });
    await act(async () => fireEvent.click(button));
    expect(resendConfirmationAction.mock.calls[0][1].get("email")).toBe("signup@example.com");
    expect(screen.getByRole("alert").textContent).toContain("Too many email requests.");
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(button.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(button));
    expect(resendConfirmationAction).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["signin", SignInForm, signInAction, "Sign in"],
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
