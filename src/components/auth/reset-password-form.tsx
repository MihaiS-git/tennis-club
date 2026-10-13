"use client";

import { useActionState } from "react";

import { resetPasswordAction } from "@/app/(auth)/actions";
import { ActionFeedback } from "@/components/action-feedback";
import { useActionErrors } from "@/components/auth-action-errors";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import { SubmitButton } from "@/components/submit-button";
import { initialAuthActionState } from "@/lib/auth/action-state";

export function ResetPasswordForm() {
  const [state, action] = useActionState(resetPasswordAction, initialAuthActionState);
  const { formRef, clearErrors, fieldError } = useActionErrors(state);

  return (
    <form ref={formRef} action={action} className="space-y-4" noValidate>
      <ActionFeedback state={state} loading="Submitting…" />
      <NewPasswordFields idPrefix="reset" fieldError={fieldError} clearErrors={clearErrors} />
      <SubmitButton pendingLabel="Resetting password…">Reset password</SubmitButton>
    </form>
  );
}
