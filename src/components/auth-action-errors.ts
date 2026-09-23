"use client";

import { useState } from "react";

import type { AuthActionState, AuthFieldName } from "@/lib/auth/action-state";

type ClearedErrors = {
  fields: Set<AuthFieldName>;
  form: boolean;
  state: AuthActionState;
};

export function useActionErrors(state: AuthActionState) {
  const [clearedErrors, setClearedErrors] = useState<ClearedErrors | null>(null);
  const isCurrentState = clearedErrors?.state === state;

  function clearErrors(fields: AuthFieldName[]) {
    setClearedErrors((current) => {
      const currentFields = current?.state === state ? current.fields : new Set<AuthFieldName>();
      return {
        state,
        form: true,
        fields: new Set([...currentFields, ...fields]),
      };
    });
  }

  function fieldError(field: AuthFieldName) {
    if (isCurrentState && clearedErrors.fields.has(field)) return undefined;
    return state.fieldErrors?.[field];
  }

  return {
    clearErrors,
    fieldError,
    formError: isCurrentState && clearedErrors.form ? undefined : state.formError,
  };
}

