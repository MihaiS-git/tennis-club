// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { UserRole } from "../../../src/lib/auth/account";

const { updateUserStatusAction, updateUserRoleAction, success, error } = vi.hoisted(() => ({
  updateUserStatusAction: vi.fn(),
  updateUserRoleAction: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../src/app/admin/users/actions", () => ({ updateUserStatusAction, updateUserRoleAction }));
vi.mock("sonner", () => ({ toast: { success, error } }));

import { UserItem } from "../../../src/app/admin/users/user-item";
import type { AdminUserListItem } from "../../../src/lib/admin/users";

const userId = "84c64ef2-6925-4901-a137-f01395541411";
const user = {
  id: userId,
  email: "member@example.com",
  created_at: "2026-09-25T23:30:00-04:00",
  updated_at: "2026-09-25T23:30:00-04:00",
  status: "active" as const,
  roles: [] as UserRole[],
};

function userTree(props: AdminUserListItem = user, currentAdminId = "other-admin") {
  return <table><tbody><UserItem currentAdminId={currentAdminId} user={props} /></tbody></table>;
}

function openDialog(props: AdminUserListItem = user, currentAdminId = "other-admin") {
  render(userTree(props, currentAdminId));
  fireEvent.click(screen.getByRole("row", { name: `Manage user ${props.email}` }));
  return screen.getByRole("dialog");
}

function roleRow(dialog: HTMLElement, label: string) {
  return within(dialog).getByText(label).closest("li") as HTMLElement;
}
function confirmation() {
  const dialogs = screen.getAllByRole("dialog");
  return dialogs[dialogs.length - 1];
}
function confirm(label: string) {
  fireEvent.click(within(confirmation()).getByRole("button", { name: label }));
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
});

afterEach(cleanup);

it("hydrates the closed user row without adding a client-only dialog", async () => {
  const browserDocument = document;
  let html: string;
  vi.stubGlobal("document", undefined);
  try {
    html = renderToString(userTree());
  } finally {
    vi.stubGlobal("document", browserDocument);
  }

  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const hydrationError = vi.spyOn(console, "error").mockImplementation(() => {});
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, userTree()); });
    expect(hydrationError).not.toHaveBeenCalled();
    expect(container.querySelector("dialog")).toBeNull();
    expect(document.body.querySelector("dialog")).toBeNull();
    fireEvent.click(within(container).getByRole("row", { name: `Manage user ${user.email}` }));
    expect(screen.getByRole("dialog", { name: "Manage user" })).toBeTruthy();
  } finally {
    await act(async () => { root?.unmount(); });
    hydrationError.mockRestore();
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps Manage User open when suspension is cancelled and restores focus", () => {
  const dialog = openDialog();
  const trigger = within(dialog).getByRole("button", { name: "Suspend user" });
  fireEvent.click(trigger);
  expect(screen.getAllByRole("dialog")).toHaveLength(2);
  expect(updateUserStatusAction).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation()).getByRole("button", { name: "Cancel" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(document.activeElement).toBe(trigger);
  expect(updateUserStatusAction).not.toHaveBeenCalled();
});
it("requires confirmation for either role removal while assignments stay direct", async () => {
  updateUserRoleAction.mockResolvedValue({ ok: true, user: { id: userId, roles: [] } });
  const dialog = openDialog({ ...user, roles: ["admin", "coach"] });
  fireEvent.click(within(roleRow(dialog, "Admin")).getByRole("button", { name: "Remove" }));
  expect(updateUserRoleAction).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation()).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" }));
  expect(updateUserRoleAction).not.toHaveBeenCalled();
  confirm("Remove Coach role");
  await waitFor(() => expect(updateUserRoleAction).toHaveBeenCalledExactlyOnceWith({ userId, role: "coach", operation: "revoke" }));
});

it("keeps state unchanged for final-active-admin", async () => {
  updateUserStatusAction.mockResolvedValue({ ok: false, reason: "final-active-admin" });
  const dialog = openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Suspend user" }));
  confirm("Suspend user");

  await waitFor(() => expect(error).toHaveBeenCalledWith("At least one active administrator must remain."));
  expect(within(dialog).getByText("Active")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Suspend user" })).toBeTruthy();
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(within(confirmation()).getByRole("alert").textContent).toBe("At least one active administrator must remain.");
  expect(within(dialog).getByRole("heading", { name: "Roles" }).closest("section")?.querySelector('[role="alert"]')).toBeNull();
});

it("clears a status error on retry and keeps a role error until its own retry", async () => {
  updateUserStatusAction.mockResolvedValueOnce({ ok: false, reason: "final-active-admin" })
    .mockResolvedValueOnce({ ok: true, user: { id: userId, status: "suspended" } });
  updateUserRoleAction.mockResolvedValueOnce({ ok: false, reason: "not-found" })
    .mockResolvedValueOnce({ ok: true, user: { id: userId, roles: ["coach"] } });
  const dialog = openDialog();
  const statusSection = within(dialog).getByRole("heading", { name: "Account status" }).closest("section")!;
  const rolesSection = within(dialog).getByRole("heading", { name: "Roles" }).closest("section")!;
  fireEvent.click(within(statusSection).getByRole("button", { name: "Suspend user" }));
  confirm("Suspend user");
  await waitFor(() => expect(within(confirmation()).getByRole("alert")).toBeTruthy());
  fireEvent.click(within(confirmation()).getByRole("button", { name: "Cancel" }));
  expect(within(statusSection).getByRole("alert")).toBeTruthy();
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));
  await waitFor(() => expect(within(rolesSection).getByRole("alert")).toBeTruthy());
  fireEvent.click(within(statusSection).getByRole("button", { name: "Suspend user" }));
  expect(within(confirmation()).queryByRole("alert")).toBeNull();
  expect(within(rolesSection).getByRole("alert")).toBeTruthy();
  confirm("Suspend user");
  await waitFor(() => expect(within(statusSection).getByText("Suspended")).toBeTruthy());
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));
  expect(within(rolesSection).queryByRole("alert")).toBeNull();
  await waitFor(() => expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" })).toBeTruthy());
});

it("synchronizes local state when refreshed user props arrive", async () => {
  const view = render(userTree());
  fireEvent.click(screen.getByRole("row", { name: `Manage user ${user.email}` }));
  const dialog = screen.getByRole("dialog");

  view.rerender(userTree({ ...user, status: "suspended", roles: ["coach"] }));
  await waitFor(() => expect(within(dialog).getByText("Suspended")).toBeTruthy());
  expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" })).toBeTruthy();
  expect(dialog.hasAttribute("open")).toBe(true);
});

it("blocks own status and admin controls while keeping coach manageable ", async () => {
  const dialog = openDialog({ ...user, roles: ["admin"] }, userId);
  const status = within(dialog).getByRole("button", { name: "Suspend user" });
  const admin = within(roleRow(dialog, "Admin")).getByRole("button", { name: "Remove" });
  expect(status.hasAttribute("disabled")).toBe(true);
  expect(admin.hasAttribute("disabled")).toBe(true);
  for (const control of [status, admin]) {
    expect(control.getAttribute("aria-busy")).toBe("false");
  }
  fireEvent.click(status);
  fireEvent.click(admin);
  expect(updateUserStatusAction).not.toHaveBeenCalled();
  expect(updateUserRoleAction).not.toHaveBeenCalled();

  updateUserRoleAction.mockResolvedValueOnce({ ok: true, user: { id: userId, roles: ["admin", "coach"] } });
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));
  await waitFor(() => expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(false));
  updateUserRoleAction.mockResolvedValueOnce({ ok: true, user: { id: userId, roles: ["admin"] } });
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" }));
  confirm("Remove Coach role");
  await waitFor(() => expect(updateUserRoleAction).toHaveBeenLastCalledWith({ userId, role: "coach", operation: "revoke" }));
});

