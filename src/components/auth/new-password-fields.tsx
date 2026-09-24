"use client";

import { useState } from "react";

import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import type { AuthFieldName } from "@/lib/auth/action-state";

export function NewPasswordFields({
  idPrefix,
  fieldError,
  clearErrors,
}: {
  idPrefix: string;
  fieldError: (field: AuthFieldName) => string | undefined;
  clearErrors: (fields: AuthFieldName[]) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const passwordError = fieldError("password");
  const confirmationError = fieldError("confirmPassword");
  const passwordId = `${idPrefix}-password`;
  const passwordErrorId = `${passwordId}-error`;
  const guidanceId = `${passwordId}-guidance`;
  const confirmationId = `${idPrefix}-confirm-password`;
  const confirmationErrorId = `${confirmationId}-error`;

  return (
    <>
      <FormField label="New password" htmlFor={passwordId} error={passwordError} errorId={passwordErrorId}>
        <PasswordInput
          id={passwordId}
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearErrors(["password", "confirmPassword"]);
          }}
          aria-invalid={Boolean(passwordError)}
          aria-describedby={`${guidanceId}${passwordError ? ` ${passwordErrorId}` : ""}`}
        />
        <p id={guidanceId} className="mt-1 text-sm text-muted-foreground">
          Use at least 15 characters. A longer passphrase is fine.
        </p>
      </FormField>
      <FormField label="Confirm new password" htmlFor={confirmationId} error={confirmationError} errorId={confirmationErrorId}>
        <PasswordInput
          id={confirmationId}
          name="confirmPassword"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value);
            clearErrors(["confirmPassword"]);
          }}
          aria-invalid={Boolean(confirmationError)}
          aria-describedby={confirmationError ? confirmationErrorId : undefined}
        />
      </FormField>
    </>
  );
}
