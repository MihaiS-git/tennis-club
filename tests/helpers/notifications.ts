import { beforeEach, afterEach, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { toast } from "sonner";

type ToastType = "loading" | "success" | "error" | "warning";
type Entry = ReturnType<typeof toast.getHistory>[number];

// Sonner's store is module-global and outlives each test, so only toasts emitted during the
// current test count as evidence. Every create, and every update of an existing id, replaces
// its history entry with a new object; unseen objects are logged here in emission order.
const seen = new WeakSet<Entry>();
let emitted: Entry[] = [];
let windowStart = 0; // first entry of the operation the last expectToast matched
let next = 0; // the next expectToast needs an entry from here on

function collect() {
  for (const entry of toast.getHistory()) if (!seen.has(entry)) { seen.add(entry); emitted.push(entry); }
}
function latest(type: ToastType, from: number) {
  for (let index = emitted.length - 1; index >= from; index--) {
    const entry = emitted[index];
    if ("type" in entry && entry.type === type) return index;
  }
  return -1;
}
const title = (entry: Entry | undefined) => String(entry && "title" in entry ? entry.title ?? "" : "");

beforeEach(() => {
  collect(); emitted = []; windowStart = 0; next = 0;
  for (const type of ["loading", "success", "error", "info", "warning", "promise"] as const) {
    const original = toast[type] as (...args: unknown[]) => unknown;
    // Calls still reach Sonner; logging right after each call keeps same-id updates in order.
    vi.spyOn(toast, type).mockImplementation(((...args: unknown[]) => { const result = original(...args); collect(); return result; }) as never);
  }
  vi.spyOn(toast, "dismiss");
});
// No consumer mounts a Toaster, so dismissal is synchronous; toasts emitted after this point are
// excluded from the next test by its starting collect().
afterEach(() => { toast.dismiss(); vi.restoreAllMocks(); });

// Latest toast of the type in the current operation: since the start of the window searched by
// the last successful expectToast, or since the start of the test.
export function lastToast(type: ToastType = "error") {
  collect();
  return title(emitted[latest(type, windowStart)]);
}
// Waits for a toast of the type emitted after the one matched by the previous expectToast, and
// checks the newest such toast, so an earlier toast can never satisfy a later operation.
export async function expectToast(message?: string | RegExp, type: ToastType = "error") {
  const index = await waitFor(() => {
    collect();
    const found = latest(type, next);
    expect(found, `a new ${type} toast`).toBeGreaterThanOrEqual(0);
    if (message instanceof RegExp) expect(title(emitted[found])).toMatch(message);
    else if (message !== undefined) expect(title(emitted[found])).toContain(message);
    return found;
  });
  windowStart = next; next = index + 1;
}
