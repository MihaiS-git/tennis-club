"use client";

import { useState } from "react";
import type { CoachingMutationResult } from "@/lib/coaching/validation";

export const selectClass = "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/20";
export const textareaClass = "w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20";
export const labelClass = "mb-1.5 block text-sm font-medium";
export const hintClass = "mt-1 text-xs text-muted-foreground";

type Failure = Exclude<CoachingMutationResult, { ok: true } | { reason: "invalid-input" }>["reason"];

export const coachingFailureMessages: Record<Failure, string> = {
  "has-bookings": "This program has booking history and cannot be deleted. Deactivate it instead.",
  "active-lessons": "This coach has active lessons or pending checkout holds. Handle those lessons first, then remove the coach.",
  "not-found": "This item no longer exists. Refresh the page.",
  "has-prices": "Prices still depend on this. Remove those prices first.",
  "has-availability": "Coach availability still uses this location. Remove that availability first.",
  "not-eligible": "Only active accounts with the Coach role can have a coaching profile or be shown publicly.",
  "already-exists": "This already exists. Refresh the page.",
  "invalid-location": "Select a current location.",
  "invalid-program": "Select an existing program and duration.",
  "not-offered": "The coach must offer this program before an individual price can be set.",
};

// Field errors keyed by field name, rendered beside the failed control.
export function useFieldErrors(prefix: string) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  function errorProps(field: string) {
    return { "aria-invalid": Boolean(fieldErrors[field]), "aria-describedby": fieldErrors[field] ? `${prefix}-${field}-error` : undefined };
  }
  function fieldError(field: string) {
    return fieldErrors[field] && <p id={`${prefix}-${field}-error`} className="mt-1 text-sm text-danger">{fieldErrors[field]}</p>;
  }
  return { fieldErrors, setFieldErrors, errorProps, fieldError };
}

export function formText(data: FormData, field: string) {
  const value = data.get(field);
  return typeof value === "string" ? value : "";
}

// Empty optional counts are null; anything else is sent for server validation.
export function optionalNumber(value: string) {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}
