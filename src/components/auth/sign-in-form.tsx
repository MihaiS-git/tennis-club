"use client";

import { useActionState, useState } from "react";

import { signInAction } from "@/app/(auth)/actions";
import { FormMessage } from "@/components/auth-form";
import { useActionErrors } from "@/components/auth-action-errors";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/input";
import { PasswordInput } from "@/components/password-input";
import { SubmitButton } from "@/components/submit-button";
import { initialAuthActionState } from "@/lib/auth/action-state";

export function SignInForm() {
  const [state, action] = useActionState(signInAction, initialAuthActionState);
  const { formRef, clearErrors, fieldError, formError } = useActionErrors(state);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form ref={formRef} action={action} className="space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField label="Email" htmlFor="signin-email" error={fieldError("email")} errorId="signin-email-error">
        <Input
          id="signin-email"
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
          aria-describedby={fieldError("email") ? "signin-email-error" : undefined}
        />
      </FormField>
      <FormField label="Password" htmlFor="signin-password" error={fieldError("password")} errorId="signin-password-error">
        <PasswordInput
          id="signin-password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
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
