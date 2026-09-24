"use client";

import { useActionState, useState } from "react";

import { changePasswordAction } from "@/app/account/actions";
import { FormMessage } from "@/components/auth-form";
import { useActionErrors } from "@/components/auth-action-errors";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { SubmitButton } from "@/components/submit-button";
import { initialAuthActionState } from "@/lib/auth/action-state";

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, initialAuthActionState);
  const { formRef, clearErrors, fieldError, formError } = useActionErrors(state);
  const [currentPassword, setCurrentPassword] = useState("");

  return (
    <form ref={formRef} action={action} className="mt-4 space-y-4" noValidate>
      <FormMessage>{formError}</FormMessage>
      <FormField label="Current password" htmlFor="current-password" error={fieldError("currentPassword")} errorId="current-password-error">
        <PasswordInput
          id="current-password"
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
      </FormField>
      <NewPasswordFields idPrefix="change" fieldError={fieldError} clearErrors={clearErrors} />
      <SubmitButton pendingLabel="Changing password…">Change password</SubmitButton>
    </form>
  );
}
