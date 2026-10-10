"use client";

import { useRef, useState } from "react";

// Compare only editable fields. Multiple values (courts and weekdays) have no meaningful order.
export function useEditableFormBaseline(
  fields: readonly string[],
  normalize: (field: string, value: string) => string = (_, value) => value.trim(),
  validate?: (form: HTMLFormElement) => boolean,
) {
  const formRef = useRef<HTMLFormElement>(null);
  const sessionForm = useRef<HTMLFormElement | null>(null);
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [valid, setValid] = useState(false);
  function readableForm(form: HTMLFormElement) {
    if (!form.querySelector(":disabled")) return form;
    // Pending fieldsets must not remove editable values from comparison or
    // validation. Never unlock the live form, even briefly.
    const copy = form.cloneNode(true);
    if (!(copy instanceof HTMLFormElement)) return form;
    const controls = form.querySelectorAll("input, select, textarea");
    copy.querySelectorAll("input, select, textarea").forEach((control, index) => {
      const source = controls[index];
      if (control instanceof HTMLInputElement && source instanceof HTMLInputElement) {
        if (source.type !== "file") control.value = source.value;
        control.checked = source.checked;
      } else if (control instanceof HTMLSelectElement && source instanceof HTMLSelectElement) {
        Array.from(control.options).forEach((option, optionIndex) => {
          option.selected = source.options[optionIndex].selected;
        });
      } else if (control instanceof HTMLTextAreaElement && source instanceof HTMLTextAreaElement) {
        control.value = source.value;
      }
    });
    copy.querySelectorAll("[disabled]").forEach((control) => control.removeAttribute("disabled"));
    return copy;
  }
  function snapshot(form: HTMLFormElement) {
    const data = new FormData(form);
    return JSON.stringify(fields.map((field) => data.getAll(field)
      .filter((value): value is string => typeof value === "string")
      .map((value) => normalize(field, value)).sort()));
  }
  function attach(form: HTMLFormElement | null) {
    formRef.current = form;
    // React also detaches callback refs when their identity changes. Only a
    // different form element (or an explicit reset) starts a new session.
    if (form && (sessionForm.current !== form || baseline.current === null)) {
      sessionForm.current = form;
      const current = readableForm(form);
      baseline.current = snapshot(current);
      setDirty(false);
      setValid(validate ? validate(current) : current.checkValidity());
    }
  }
  function sync() {
    if (!formRef.current) return;
    const form = readableForm(formRef.current);
    const current = snapshot(form);
    if (baseline.current === null) baseline.current = current;
    setDirty(current !== baseline.current);
    setValid(validate ? validate(form) : form.checkValidity());
  }
  function submitted(form: HTMLFormElement) { return snapshot(readableForm(form)); }
  function commit(saved: string) {
    baseline.current = saved;
    sync();
  }
  function reset() { baseline.current = null; setDirty(false); setValid(false); }
  return { attach, dirty, valid, sync, submitted, commit, reset };
}
