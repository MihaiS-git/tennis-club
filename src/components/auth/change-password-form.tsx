"use client";

import { useActionState, useEffect } from "react";

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

  useEffect(() => {
    if (!state.success) return;
    for (const name of ["currentPassword", "password", "confirmPassword"]) {
      const input = formRef.current?.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.value = "";
    }
  }, [state, formRef]);

  return (
    <form ref={formRef} action={action} className="mt-4 space-y-4 [&_input]:min-h-11" noValidate>
      <FormMessage>{formError}</FormMessage>
      {state.success && <p role="status" className="text-sm text-accent">{state.success}</p>}
      <FormField label="Current password" htmlFor="current-password" error={fieldError("currentPassword")} errorId="current-password-error">
        <PasswordInput
          id="current-password"
          name="currentPassword"
          autoComplete="current-password"
          required
          onChange={() => {
            clearErrors(["currentPassword", "password"]);
          }}
          aria-invalid={Boolean(fieldError("currentPassword"))}
          aria-describedby={fieldError("currentPassword") ? "current-password-error" : undefined}
        />
      </FormField>
      <NewPasswordFields idPrefix="change" fieldError={fieldError} clearErrors={clearErrors} />
      <div className="w-full sm:w-fit [&>button]:min-h-11"><SubmitButton pendingLabel="Changing password…">Change password</SubmitButton></div>
    </form>
  );
}
