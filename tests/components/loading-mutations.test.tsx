// @vitest-environment jsdom
import { Suspense, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogMock } from "../helpers/dialog";
import { InboxList, type InboxRow } from "@/app/messages/inbox-list";
import { ProgramsTable } from "@/app/admin/coaching/programs/programs-table";
import { CoachesTable } from "@/app/admin/coaching/coaches/coaches-table";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";
import type { AdminCoach, AdminCoachingProgram } from "@/lib/coaching/admin";
import type { AdminCoachListItem } from "@/lib/coaching/admin-lists";

const mocks = vi.hoisted(() => ({ update: vi.fn(), deleteOne: vi.fn(), program: vi.fn(), coach: vi.fn(),
  refresh: vi.fn(), replace: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }) }));
vi.mock("@/app/messages/actions", () => ({ updateSelectedMessagesAction: mocks.update, deleteMessageAction: mocks.deleteOne }));
vi.mock("@/app/admin/coaching/actions", () => ({ setCoachingProgramStatusAction: mocks.program, setCoachVisibilityAction: mocks.coach }));
vi.mock("sonner", () => ({ toast: { loading: () => "operation", success: mocks.success, error: mocks.error } }));

const row: InboxRow = { id: "message-1", subject: "Booking", bodyText: "Confirmed", category: "Bookings", read: false,
  createdAt: "2026-10-22T10:00:00Z", createdLabel: "22 Oct" };
const program: AdminCoachingProgram = { id: "program-1", name: "Private lesson", description: "", program_type: "private",
  durations: [60], min_participants: 1, max_participants: 1, court_rental_included: true, is_active: false };
const coach: AdminCoach = { user_id: "coach-1", display_name: "Ana", bio: "", qualifications: "", specialties: [], languages: [],
  is_public: false, email: "ana@example.test", location_ids: [], program_ids: [], ineligibility: null };
function coachItem(profile: AdminCoach): AdminCoachListItem {
  return { user_id: profile.user_id, name: profile.display_name, email: profile.email, account_status: "active",
    profile_status: "configured", profile };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Model the router's refresh as a suspended React update, rather than a promise
// returned by refresh (the actual router returns void).
function renderRefresh(content: (refreshed: boolean) => ReactNode) {
  const gate = deferred();
  let ready = false;
  function Page({ refreshed }: { refreshed: boolean }) {
    if (refreshed && !ready) throw gate.promise;
    return content(refreshed);
  }
  function Router() {
    const [refreshed, setRefreshed] = useState(false);
    mocks.refresh.mockImplementation(() => { setRefreshed(true); });
    mocks.replace.mockImplementation(() => { setRefreshed(true); });
    return <Suspense fallback="Refreshing"><Page refreshed={refreshed} /></Suspense>;
  }
  render(<Router />);
  return async () => { await act(async () => { ready = true; gate.resolve(); }); };
}
beforeEach(() => { vi.resetAllMocks(); installDialogMock(); });
afterEach(cleanup);

it.each(["read", "unread", "delete", "single-delete"] as const)("keeps inbox %s pending through refresh and prevents duplicates", async (operation) => {
  const mutation = deferred();
  mocks.update.mockImplementation(async () => { await mutation.promise; return { updated: 1 }; });
  mocks.deleteOne.mockImplementation(() => mutation.promise);
  const changed = vi.fn();
  window.addEventListener("messages:changed", changed);
  const finishRefresh = renderRefresh((refreshed) => <InboxList rows={refreshed && operation.includes("delete") ? [] : [{ ...row, read: refreshed && operation === "read" }]}
    query={parseInboxQuery({ page: "2" })} search="page=2" />);
  if (operation === "single-delete") fireEvent.click(screen.getByRole("button", { name: "Delete Booking" }));
  else {
    fireEvent.click(screen.getByRole("button", { name: "Select page" }));
    fireEvent.click(screen.getByRole("button", { name: operation === "delete" ? "Delete selected" : `Mark ${operation}` }));
    if (operation === "delete") fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete selected" }));
  }
  const action = operation === "single-delete" ? mocks.deleteOne : mocks.update;
  expect(action).toHaveBeenCalledTimes(1);
  await act(async () => mutation.resolve());
  expect(changed).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Select page" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
  const pendingButton = screen.getByRole("button", { name: operation === "single-delete" ? "Deleting Booking" : operation === "delete" ? "Deleting…" : `Marking ${operation}…` });
  fireEvent.click(pendingButton);
  fireEvent.click(screen.getByRole("button", { name: /Delet.*Booking/ }));
  expect(action).toHaveBeenCalledTimes(1);
  if (operation.includes("delete")) expect(mocks.replace).toHaveBeenCalledWith("/messages?page=1");
  else expect(mocks.refresh).toHaveBeenCalledTimes(1);
  await finishRefresh();
  expect(screen.queryByText(/Marking|Deleting…/)).toBeNull();
  if (!operation.includes("delete")) expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(false);
  else expect(screen.queryByRole("checkbox")).toBeNull();
  window.removeEventListener("messages:changed", changed);
});

it.each(["read", "unread", "delete", "single-delete"] as const)("restores inbox interaction after failed %s", async (operation) => {
  mocks.update.mockRejectedValue(new Error("failed")); mocks.deleteOne.mockRejectedValue(new Error("failed"));
  render(<InboxList rows={[row]} query={parseInboxQuery({})} search="page=1" />);
  if (operation === "single-delete") fireEvent.click(screen.getByRole("button", { name: "Delete Booking" }));
  else {
    fireEvent.click(screen.getByRole("button", { name: "Select page" }));
    fireEvent.click(screen.getByRole("button", { name: operation === "delete" ? "Delete selected" : `Mark ${operation}` }));
    if (operation === "delete") fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete selected" }));
  }
  expect((await screen.findByRole("alert")).textContent).toContain("Try again.");
  await waitFor(() => expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(false));
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
});

it.each(["program", "coach"] as const)("shows confirmed %s values with stale props and stays pending through refresh", async (kind) => {
  const mutation = deferred();
  mocks[kind].mockImplementation(async () => { await mutation.promise; return { ok: true }; });
  const finishRefresh = renderRefresh(refreshed => kind === "program" ? <ProgramsTable programs={[{ ...program, is_active: refreshed }]} />
    : <CoachesTable coaches={[coachItem({ ...coach, is_public: refreshed })]} locations={[]} programs={[]} />);
  const select = screen.getAllByRole<HTMLSelectElement>("combobox")[0];
  fireEvent.change(select, { target: { value: "true" } });
  expect(select.disabled).toBe(true);
  fireEvent.change(select, { target: { value: "true" } });
  expect(mocks[kind]).toHaveBeenCalledTimes(1);
  expect(select.value).toBe("false");
  await act(async () => mutation.resolve());
  expect(select.value).toBe("true");
  expect(select.disabled).toBe(true);
  expect(mocks.success).toHaveBeenCalledTimes(1);
  fireEvent.change(select, { target: { value: "true" } });
  expect(mocks[kind]).toHaveBeenCalledTimes(1);
  await finishRefresh();
  expect(select.value).toBe("true");
  expect(select.disabled).toBe(false);
});

it.each(["program", "coach"] as const)("restores previous %s value after rejected and thrown saves and permits retry", async (kind) => {
  mocks[kind].mockResolvedValueOnce({ ok: false, reason: "not-found" }).mockRejectedValueOnce(new Error("failed"))
    .mockResolvedValueOnce({ ok: true });
  const finishRefresh = renderRefresh(refreshed => kind === "program" ? <ProgramsTable programs={[{ ...program, is_active: refreshed }]} />
    : <CoachesTable coaches={[coachItem({ ...coach, is_public: refreshed })]} locations={[]} programs={[]} />);
  const select = screen.getAllByRole<HTMLSelectElement>("combobox")[0];
  for (let failures = 1; failures <= 2; failures++) {
    fireEvent.change(select, { target: { value: "true" } });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(failures));
    expect(select.value).toBe("false"); expect(select.disabled).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
  }
  fireEvent.change(select, { target: { value: "true" } });
  await waitFor(() => expect(select.value).toBe("true"));
  expect(mocks[kind]).toHaveBeenCalledTimes(3);
  await finishRefresh();
  expect(select.value).toBe("true");
});


it.each(["program", "coach"] as const)("confirms deactivation where required and synchronizes incoming %s state", async (kind) => {
  mocks[kind].mockResolvedValue({ ok: true });
  const content = (value: boolean) => kind === "program" ? <ProgramsTable programs={[{ ...program, is_active: value }]} />
    : <CoachesTable coaches={[coachItem({ ...coach, is_public: value })]} locations={[]} programs={[]} />;
  const { rerender } = render(content(true));
  mocks.refresh.mockImplementation(() => rerender(content(false)));
  const select = screen.getAllByRole<HTMLSelectElement>("combobox")[0];
  fireEvent.change(select, { target: { value: "false" } });
  if (kind === "program") {
    expect(mocks.program).not.toHaveBeenCalled();
    expect(select.value).toBe("true");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(select.value).toBe("true");
    fireEvent.change(select, { target: { value: "false" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deactivate program" }));
  }
  await waitFor(() => expect(select.value).toBe("false"));
  expect(mocks[kind]).toHaveBeenCalledTimes(1);
  rerender(content(false));
  expect(select.value).toBe("false");
  rerender(content(true));
  expect(select.value).toBe("true");
});

it.each(["program", "coach"] as const)("uses authoritative refreshed %s state if it differs from the saved value", async kind => {
  mocks[kind].mockResolvedValue({ ok: true });
  const finishRefresh = renderRefresh(() => kind === "program" ? <ProgramsTable programs={[program]} />
    : <CoachesTable coaches={[coachItem(coach)]} locations={[]} programs={[]} />);
  const select = screen.getAllByRole<HTMLSelectElement>("combobox")[0];
  fireEvent.change(select, { target: { value: "true" } });
  await waitFor(() => expect(select.value).toBe("true"));
  expect(select.disabled).toBe(true);
  await finishRefresh();
  expect(select.value).toBe("false");
  expect(select.disabled).toBe(false);
});
