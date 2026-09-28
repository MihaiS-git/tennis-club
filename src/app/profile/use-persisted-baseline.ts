"use client";

import { useActionState, useState } from "react";
import type { ProfileActionState } from "@/lib/profile/validation";

type Values = Record<string, string | null>;

// Match existing persistence semantics even when current input is invalid.
function snapshot(values: Values, fields: readonly string[]) {
  return JSON.stringify(fields.map((field) => {
    const value = values[field] ?? "";
    if (field === "country_code") return value.trim().toUpperCase();
    if (["date_of_birth", "sportya_level", "handedness", "backhand", "preferred_game", "preferred_surface"].includes(field)) return value;
    return value.trim();
  }));
}

export function usePersistedBaseline(
  save: (state: ProfileActionState, data: FormData) => Promise<ProfileActionState>,
  values: Values,
  fields: readonly string[],
) {
  const [baseline, setBaseline] = useState(() => snapshot(values, fields));
  const [state, action] = useActionState(async (previous: ProfileActionState, data: FormData) => {
    const submitted = snapshot(Object.fromEntries(fields.map((field) => {
      const value = data.get(field);
      return [field, typeof value === "string" ? value : ""];
    })), fields);
    const result = await save(previous, data);
    // Capture the submission, never newer edits made while the save was pending.
    if (result.success) setBaseline(submitted);
    return result;
  }, {});
  return { state, action, dirty: snapshot(values, fields) !== baseline };
}
