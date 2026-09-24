"use client";

import { useActionState, useState } from "react";

import { signUpAction } from "@/app/(auth)/actions";
import { FormMessage } from "@/components/auth-form";
import { useActionErrors } from "@/components/auth-action-errors";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/input";
import { SubmitButton } from "@/components/submit-button";
import { initialAuthActionState } from "@/lib/auth/action-state";

export function SignUpForm() {
  const [state, action] = useActionState(signUpAction, initialAuthActionState);
  const { formRef, clearErrors, fieldError, formError } = useActionErrors(state);
  const [email, setEmail] = useState("");

  return (
    <form ref={formRef} action={action} className="space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField label="Email" htmlFor="signup-email" error={fieldError("email")} errorId="signup-email-error">
        <Input
          id="signup-email"
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
      </FormField>
      <NewPasswordFields idPrefix="signup" fieldError={fieldError} clearErrors={clearErrors} />
      <SubmitButton pendingLabel="Creating account…">Sign up</SubmitButton>
    </form>
  );
}
