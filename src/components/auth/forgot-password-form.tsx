"use client";

import { useActionState, useState } from "react";

import { forgotPasswordAction } from "@/app/(auth)/actions";
import { FormMessage } from "@/components/auth-form";
import { useActionErrors } from "@/components/auth-action-errors";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/input";
import { SubmitButton } from "@/components/submit-button";
import { initialAuthActionState } from "@/lib/auth/action-state";

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, initialAuthActionState);
  const { formRef, clearErrors, fieldError, formError } = useActionErrors(state);
  const [email, setEmail] = useState("");

  return (
    <form ref={formRef} action={action} className="space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField label="Email" htmlFor="recovery-email" error={fieldError("email")} errorId="recovery-email-error">
        <Input
          id="recovery-email"
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
      </FormField>
      <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
    </form>
  );
}
