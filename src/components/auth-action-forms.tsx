"use client";

import { useActionState, useState, type ReactNode } from "react";

import {
  forgotPasswordAction,
  resetPasswordAction,
  signInAction,
  signUpAction,
} from "@/app/(auth)/actions";
import { changePasswordAction } from "@/app/account/actions";
import { FormMessage } from "@/components/auth-form";
import { useActionErrors } from "@/components/auth-action-errors";
import { PasswordInput } from "@/components/password-input";
import { SubmitButton } from "@/components/submit-button";
import { initialAuthActionState } from "@/lib/auth/action-state";

function FieldError({ id, children }: { id: string; children?: string }) {
  if (!children) return null;

  return (
    <p id={id} role="alert" className="mt-1 text-sm font-normal text-red-700">
      {children}
    </p>
  );
}

function FormField({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

export function SignUpForm() {
  const [state, action] = useActionState(signUpAction, initialAuthActionState);
  const { clearErrors, fieldError, formError } = useActionErrors(state);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField>
        <label htmlFor="signup-email" className="block text-sm font-medium text-zinc-800">Email</label>
        <input
          id="signup-email"
          className="w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20 mt-1"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            clearErrors(["email"]);
          }}
          aria-invalid={Boolean(fieldError("email"))}
          aria-describedby={fieldError("email") ? "signup-email-error" : undefined}
        />
        <FieldError id="signup-email-error">{fieldError("email")}</FieldError>
      </FormField>
      <FormField>
        <label htmlFor="signup-password" className="block text-sm font-medium text-zinc-800">Password</label>
        <PasswordInput
          id="signup-password"
          containerClassName="mt-1"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearErrors(["password", "confirmPassword"]);
          }}
          aria-invalid={Boolean(fieldError("password"))}
          aria-describedby={fieldError("password") ? "signup-password-error" : undefined}
        />
        <FieldError id="signup-password-error">{fieldError("password")}</FieldError>
      </FormField>
      <FormField>
        <label htmlFor="signup-confirm-password" className="block text-sm font-medium text-zinc-800">Confirm password</label>
        <PasswordInput
          id="signup-confirm-password"
          containerClassName="mt-1"
          name="confirmPassword"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value);
            clearErrors(["confirmPassword"]);
          }}
          aria-invalid={Boolean(fieldError("confirmPassword"))}
          aria-describedby={fieldError("confirmPassword") ? "signup-confirm-password-error" : undefined}
        />
        <FieldError id="signup-confirm-password-error">{fieldError("confirmPassword")}</FieldError>
      </FormField>
      <SubmitButton pendingLabel="Creating account…">Sign up</SubmitButton>
    </form>
  );
}

export function SignInForm({ next }: { next: string }) {
  const [state, action] = useActionState(signInAction, initialAuthActionState);
  const { clearErrors, fieldError, formError } = useActionErrors(state);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <input type="hidden" name="next" value={next} />
      <FormField>
        <label htmlFor="signin-email" className="block text-sm font-medium text-zinc-800">Email</label>
        <input
          id="signin-email"
          className="w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20 mt-1"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            clearErrors(["email", "password"]);
          }}
          aria-invalid={Boolean(fieldError("email"))}
          aria-describedby={fieldError("email") ? "signin-email-error" : undefined}
        />
        <FieldError id="signin-email-error">{fieldError("email")}</FieldError>
      </FormField>
      <FormField>
        <label htmlFor="signin-password" className="block text-sm font-medium text-zinc-800">Password</label>
        <PasswordInput
          id="signin-password"
          containerClassName="mt-1"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearErrors(["email", "password"]);
          }}
          aria-invalid={Boolean(fieldError("password"))}
          aria-describedby={fieldError("password") ? "signin-password-error" : undefined}
        />
        <FieldError id="signin-password-error">{fieldError("password")}</FieldError>
      </FormField>
      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, initialAuthActionState);
  const { clearErrors, fieldError, formError } = useActionErrors(state);
  const [email, setEmail] = useState("");

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField>
        <label htmlFor="recovery-email" className="block text-sm font-medium text-zinc-800">Email</label>
        <input
          id="recovery-email"
          className="w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20 mt-1"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            clearErrors(["email"]);
          }}
          aria-invalid={Boolean(fieldError("email"))}
          aria-describedby={fieldError("email") ? "recovery-email-error" : undefined}
        />
        <FieldError id="recovery-email-error">{fieldError("email")}</FieldError>
      </FormField>
      <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm() {
  const [state, action] = useActionState(resetPasswordAction, initialAuthActionState);
  const { clearErrors, fieldError, formError } = useActionErrors(state);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField>
        <label htmlFor="reset-password" className="block text-sm font-medium text-zinc-800">New password</label>
        <PasswordInput
          id="reset-password"
          containerClassName="mt-1"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearErrors(["password", "confirmPassword"]);
          }}
          aria-invalid={Boolean(fieldError("password"))}
          aria-describedby={fieldError("password") ? "reset-password-error" : undefined}
        />
        <FieldError id="reset-password-error">{fieldError("password")}</FieldError>
      </FormField>
      <FormField>
        <label htmlFor="reset-confirm-password" className="block text-sm font-medium text-zinc-800">Confirm new password</label>
        <PasswordInput
          id="reset-confirm-password"
          containerClassName="mt-1"
          name="confirmPassword"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value);
            clearErrors(["confirmPassword"]);
          }}
          aria-invalid={Boolean(fieldError("confirmPassword"))}
          aria-describedby={fieldError("confirmPassword") ? "reset-confirm-password-error" : undefined}
        />
        <FieldError id="reset-confirm-password-error">{fieldError("confirmPassword")}</FieldError>
      </FormField>
      <SubmitButton pendingLabel="Resetting password…">Reset password</SubmitButton>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, initialAuthActionState);
  const { clearErrors, fieldError, formError } = useActionErrors(state);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  return (
    <form action={action} className="mt-4 space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField>
        <label htmlFor="current-password" className="block text-sm font-medium text-zinc-800">Current password</label>
        <PasswordInput
          id="current-password"
          containerClassName="mt-1"
          name="currentPassword"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => {
            setCurrentPassword(event.target.value);
            clearErrors(["currentPassword", "password"]);
          }}
          aria-invalid={Boolean(fieldError("currentPassword"))}
          aria-describedby={fieldError("currentPassword") ? "current-password-error" : undefined}
        />
        <FieldError id="current-password-error">{fieldError("currentPassword")}</FieldError>
      </FormField>
      <FormField>
        <label htmlFor="new-password" className="block text-sm font-medium text-zinc-800">New password</label>
        <PasswordInput
          id="new-password"
          containerClassName="mt-1"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearErrors(["password", "confirmPassword"]);
          }}
          aria-invalid={Boolean(fieldError("password"))}
          aria-describedby={fieldError("password") ? "new-password-error" : undefined}
        />
        <FieldError id="new-password-error">{fieldError("password")}</FieldError>
      </FormField>
      <FormField>
        <label htmlFor="change-confirm-password" className="block text-sm font-medium text-zinc-800">Confirm new password</label>
        <PasswordInput
          id="change-confirm-password"
          containerClassName="mt-1"
          name="confirmPassword"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value);
            clearErrors(["confirmPassword"]);
          }}
          aria-invalid={Boolean(fieldError("confirmPassword"))}
          aria-describedby={fieldError("confirmPassword") ? "change-confirm-password-error" : undefined}
        />
        <FieldError id="change-confirm-password-error">{fieldError("confirmPassword")}</FieldError>
      </FormField>
      <SubmitButton pendingLabel="Changing password…">Change password</SubmitButton>
    </form>
  );
}
