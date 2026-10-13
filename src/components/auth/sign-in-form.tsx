"use client";

import { useActionState, useState } from "react";

import { signInAction } from "@/app/(auth)/actions";
import { ResendConfirmation } from "@/components/auth/resend-confirmation";
import { ActionFeedback } from "@/components/action-feedback";
import { useActionErrors } from "@/components/auth-action-errors";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/input";
import { PasswordInput } from "@/components/password-input";
import { SubmitButton } from "@/components/submit-button";
import { initialAuthActionState } from "@/lib/auth/action-state";

export function SignInForm() {
  const [state, action] = useActionState(signInAction, initialAuthActionState);
  const { formRef, clearErrors, fieldError, formError } = useActionErrors(state);
  const [confirmationEmailError, setConfirmationEmailError] = useState<string | undefined>();
  const emailError = confirmationEmailError ?? fieldError("email");

  return (
    <form ref={formRef} action={action} className="space-y-4" noValidate>
      <ActionFeedback state={state} loading="Submitting…" />
      {state.emailUnconfirmed && formError ? (
        <ResendConfirmation onEmailError={setConfirmationEmailError} getEmail={() => {
          const email = formRef.current?.elements.namedItem("email");
          return email instanceof HTMLInputElement ? email.value : "";
        }} />
      ) : null}
      <FormField label="Email" htmlFor="signin-email" error={emailError} errorId="signin-email-error">
        <Input
          id="signin-email"
          type="email"
          name="email"
          autoComplete="email"
          required
          onChange={() => {
            clearErrors(["email"]);
            setConfirmationEmailError(undefined);
          }}
          aria-invalid={Boolean(emailError)}
          aria-describedby={emailError ? "signin-email-error" : undefined}
        />
      </FormField>
      <FormField label="Password" htmlFor="signin-password" error={fieldError("password")} errorId="signin-password-error">
        <PasswordInput
          id="signin-password"
          name="password"
          autoComplete="current-password"
          required
          onChange={() => {
            clearErrors(["password"]);
          }}
          aria-invalid={Boolean(fieldError("password"))}
          aria-describedby={fieldError("password") ? "signin-password-error" : undefined}
        />
      </FormField>
      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}
