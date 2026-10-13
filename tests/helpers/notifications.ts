import { beforeEach, afterEach, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { toast } from "sonner";

beforeEach(() => {
  for (const type of ["loading", "success", "error", "info", "warning", "promise", "dismiss"] as const) vi.spyOn(toast, type);
});
afterEach(() => { toast.dismiss(); vi.restoreAllMocks(); });

export function lastToast(type: "loading" | "success" | "error" | "warning" = "error") {
  const active = toast.getToasts().findLast((item) => "type" in item && item.type === type);
  return String(vi.mocked(toast[type]).mock.calls.at(-1)?.[0] ?? (active && "title" in active ? active.title : ""));
}
export async function expectToast(message?: string | RegExp, type: "loading" | "success" | "error" | "warning" = "error") {
  await waitFor(() => {
    expect(vi.mocked(toast[type]).mock.calls.length > 0 || toast.getToasts().some((item) => "type" in item && item.type === type)).toBe(true);
    if (message instanceof RegExp) expect(lastToast(type)).toMatch(message);
    else if (message !== undefined) expect(lastToast(type)).toContain(message);
  });
}
