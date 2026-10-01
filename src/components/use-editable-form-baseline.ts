"use client";

import { useRef, useState } from "react";

// Compare only editable fields. Multiple values (courts and weekdays) have no meaningful order.
export function useEditableFormBaseline(
  fields: readonly string[],
  normalize: (field: string, value: string) => string = (_, value) => value.trim(),
  validate?: (form: HTMLFormElement) => boolean,
) {
  const formRef = useRef<HTMLFormElement>(null);
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [valid, setValid] = useState(false);
  function snapshot(form: HTMLFormElement) {
    const data = new FormData(form);
    return JSON.stringify(fields.map((field) => data.getAll(field)
      .filter((value): value is string => typeof value === "string")
      .map((value) => normalize(field, value)).sort()));
  }
  function attach(form: HTMLFormElement | null) {
    formRef.current = form;
    if (form && baseline.current === null) baseline.current = snapshot(form);
  }
  function sync() {
    if (!formRef.current) return;
    const current = snapshot(formRef.current);
    if (baseline.current === null) baseline.current = current;
    setDirty(current !== baseline.current);
    if (validate) setValid(validate(formRef.current));
  }
  function submitted(form: HTMLFormElement) { return snapshot(form); }
  function commit(saved: string) {
    baseline.current = saved;
    sync();
  }
  function reset() { baseline.current = null; setDirty(false); setValid(false); }
  return { attach, dirty, valid, sync, submitted, commit, reset };
}
