// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxList } from "@/app/messages/inbox-list";
import { MessageDetailActions } from "@/app/messages/[messageId]/unread-button";
import { PriceEditor } from "@/app/coach/pricing/price-editor";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";
import type { CoachingMutationResult } from "@/lib/coaching/validation";
import { installDialogMock } from "../helpers/dialog";

const mocks = vi.hoisted(() => ({ read: vi.fn(), unread: vi.fn(), delete: vi.fn(), selected: vi.fn(),
  save: vi.fn(), remove: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }) }));
vi.mock("@/app/messages/actions", () => ({ markMessageReadAction: mocks.read, markMessageUnreadAction: mocks.unread,
  deleteMessageAction: mocks.delete, updateSelectedMessagesAction: mocks.selected }));
vi.mock("sonner", () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { vi.clearAllMocks(); installDialogMock(); });
afterEach(cleanup);

it.each(["read", "unread", "delete"] as const)("shows detail %s pending feedback and blocks competing/repeated actions", async (operation) => {
  const request = deferred<void>();
  mocks[operation].mockReturnValueOnce(request.promise);
  const changed = vi.fn();
  window.addEventListener("messages:changed", changed);
  try {
    render(<MessageDetailActions id="message-1" subject="Court confirmed" returnHref="/messages?page=2" />);
    const deletion = screen.getByRole("button", { name: "Delete Court confirmed" });
    expect(deletion.textContent).toBe("");
    expect(deletion.querySelector("svg.lucide-trash-2")?.getAttribute("aria-hidden")).toBe("true");
    const button = operation === "delete" ? deletion : screen.getByRole("button", { name: `Mark ${operation}` });
    act(() => { fireEvent.click(button); fireEvent.click(button); fireEvent.click(deletion); });
    expect(mocks[operation]).toHaveBeenCalledExactlyOnceWith("message-1");
    expect(screen.getAllByRole("button").every((item) => item.hasAttribute("disabled"))).toBe(true);
    const label = operation === "delete" ? "Deleting Court confirmed" : `Marking ${operation}…`;
    expect(screen.getByRole("button", { name: label }).getAttribute("aria-busy")).toBe("true");
    if (operation === "delete") expect(screen.getByRole("status").textContent).toBe("Deleting notification…");
    expect(changed).not.toHaveBeenCalled();
    await act(async () => request.resolve());
    expect(changed).toHaveBeenCalledTimes(1);
    if (operation === "read") expect(mocks.refresh).toHaveBeenCalledTimes(1);
    else expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/messages?page=2");
    expect(screen.getAllByRole("button").every((item) => !item.hasAttribute("disabled"))).toBe(true);
  } finally { window.removeEventListener("messages:changed", changed); }
});

it("restores detail actions after failure without navigation", async () => {
  const request = deferred<void>();
  mocks.delete.mockReturnValueOnce(request.promise);
  render(<MessageDetailActions id="message-1" subject="Court confirmed" returnHref="/messages" />);
  fireEvent.click(screen.getByRole("button", { name: "Delete Court confirmed" }));
  await act(async () => request.reject(new Error("Unavailable")));
  expect(screen.getByRole("alert").textContent).toContain("Unable to update");
  expect(screen.getByRole("button", { name: "Delete Court confirmed" }).hasAttribute("disabled")).toBe(false);
  expect(mocks.push).not.toHaveBeenCalled();
});

it("keeps row deletion icon-only and contextual while blocking duplicate and bulk actions", async () => {
  const request = deferred<void>();
  mocks.delete.mockReturnValueOnce(request.promise);
  render(<InboxList rows={[{ id: "message-1", category: "Bookings", subject: "Court confirmed", bodyText: "Booked",
    read: false, createdAt: "2026-10-27T10:00:00Z", createdLabel: "Today" }]} query={parseInboxQuery({})} search="page=1" />);
  const button = screen.getByRole("button", { name: "Delete Court confirmed" });
  expect(button.textContent).toBe("");
  expect(button.querySelector("svg.lucide-trash-2")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Delete selected" }).textContent).toBe("Delete selected");
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(screen.getByRole("button", { name: "Deleting Court confirmed" }).getAttribute("aria-busy")).toBe("true");
  expect(screen.getAllByRole("button").every((item) => item.hasAttribute("disabled"))).toBe(true);
  expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("message-1");
  expect(mocks.selected).not.toHaveBeenCalled();
  await act(async () => request.resolve());
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

it("shows contextual coach price saving feedback and prevents repeated submits", async () => {
  const request = deferred<CoachingMutationResult>();
  const action = mocks.save;
  action.mockReturnValueOnce(request.promise);
  render(<PriceEditor label="My lesson price" target={{ program_id: "program-1", duration_minutes: 60,
    participant_count: 1, currency: "RON" }} emptyHint="Not set" actions={{ save: mocks.save, remove: mocks.remove }} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "150" } });
  const button = screen.getByRole("button", { name: "Save" });
  const form = button.closest("form")!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  const saving = screen.getByRole("button", { name: "Saving price…" });
  expect(saving.getAttribute("aria-busy")).toBe("true");
  expect(saving.hasAttribute("disabled")).toBe(true);
  expect(input.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  expect(action).toHaveBeenCalledTimes(1);
  await act(async () => request.resolve({ ok: false, reason: "invalid-input", fieldErrors: { amount: "Check the price." } }));
  expect(input.hasAttribute("disabled")).toBe(false);
  expect(screen.getByText("Check the price.")).toBeDefined();
  expect(input.getAttribute("value")).toBe("150");
  expect(mocks.refresh).not.toHaveBeenCalled();
});
