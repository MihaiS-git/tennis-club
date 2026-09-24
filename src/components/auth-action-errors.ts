"use client";

import { useEffect, useRef, useState } from "react";

import type { AuthActionState, AuthFieldName } from "@/lib/auth/action-state";

type ClearedErrors = {
  fields: Set<AuthFieldName>;
  form: boolean;
  state: AuthActionState;
};

export function useActionErrors(state: AuthActionState) {
  const formRef = useRef<HTMLFormElement>(null);
  const [clearedErrors, setClearedErrors] = useState<ClearedErrors | null>(null);
  const isCurrentState = clearedErrors?.state === state;

  useEffect(() => {
    if (!Object.values(state.fieldErrors ?? {}).some(Boolean)) return;
    const form = formRef.current;
    if (!form || (document.activeElement !== document.body && !form.contains(document.activeElement))) return;
    form.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

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
    formRef,
    clearErrors,
    fieldError,
    formError: isCurrentState && clearedErrors.form ? undefined : state.formError,
  };
}
