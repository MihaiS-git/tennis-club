// @vitest-environment jsdom

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

import { UserManagementDialog } from "../../../src/app/admin/users/user-management-dialog";

const userId = "84c64ef2-6925-4901-a137-f01395541411";
const user = {
  id: userId,
  email: "member@example.com",
  status: "active" as const,
  roles: ["member"] as UserRole[],
};

function openDialog(props: Parameters<typeof UserManagementDialog>[0]["user"] = user) {
  render(<UserManagementDialog user={props} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
  return screen.getByRole("dialog");
}

function roleRow(dialog: HTMLElement, label: string) {
  return within(dialog).getByText(label).closest("li") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

afterEach(cleanup);

it("renders a single Manage button while closed", () => {
  render(<UserManagementDialog user={user} />);
  expect(screen.getAllByRole("button", { name: "Manage" })).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens the native dialog from Manage", () => {
  const dialog = openDialog();
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(within(dialog).getByRole("heading", { name: "Manage user" })).toBeTruthy();
});

it("shows email, status, and all three roles", () => {
  const dialog = openDialog();
  expect(within(dialog).getByText(user.email)).toBeTruthy();
  expect(within(dialog).getByText("Active")).toBeTruthy();
  expect(within(dialog).getByRole("heading", { name: "Account status" })).toBeTruthy();
  expect(within(dialog).getByRole("heading", { name: "Roles" })).toBeTruthy();
  for (const label of ["Admin", "Coach", "Member"]) {
    expect(roleRow(dialog, label)).toBeTruthy();
  }
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
});

it("shows Suspend user for an active account", () => {
  expect(within(openDialog()).getByRole("button", { name: "Suspend user" })).toBeTruthy();
});

it("shows Reactivate user for a suspended account", () => {
  expect(within(openDialog({ ...user, status: "suspended" })).getByRole("button", { name: "Reactivate user" })).toBeTruthy();
});

it("shows Remove for an assigned role", () => {
  expect(within(roleRow(openDialog(), "Member")).getByRole("button", { name: "Remove" })).toBeTruthy();
});

it("shows Assign for an absent role", () => {
  expect(within(roleRow(openDialog(), "Coach")).getByRole("button", { name: "Assign" })).toBeTruthy();
});

it("suspends an active user and updates the displayed status", async () => {
  updateUserStatusAction.mockResolvedValue({ ok: true, user: { id: userId, status: "suspended" } });
  const dialog = openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Suspend user" }));

  await waitFor(() => expect(within(dialog).getByText("Suspended")).toBeTruthy());
  expect(updateUserStatusAction).toHaveBeenCalledExactlyOnceWith({ userId, status: "suspended" });
  expect(within(dialog).getByRole("button", { name: "Reactivate user" })).toBeTruthy();
  expect(success).toHaveBeenCalledOnce();
  expect(dialog.hasAttribute("open")).toBe(true);
});

it("reactivates a suspended user and updates the displayed status", async () => {
  updateUserStatusAction.mockResolvedValue({ ok: true, user: { id: userId, status: "active" } });
  const dialog = openDialog({ ...user, status: "suspended" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Reactivate user" }));

  await waitFor(() => expect(within(dialog).getByText("Active")).toBeTruthy());
  expect(updateUserStatusAction).toHaveBeenCalledExactlyOnceWith({ userId, status: "active" });
  expect(success).toHaveBeenCalledOnce();
});

it("assigns a role and uses the returned role list", async () => {
  updateUserRoleAction.mockResolvedValue({ ok: true, user: { id: userId, roles: ["coach", "member"] } });
  const dialog = openDialog();
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));

  await waitFor(() => expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" })).toBeTruthy());
  expect(updateUserRoleAction).toHaveBeenCalledExactlyOnceWith({ userId, role: "coach", operation: "assign" });
  expect(success).toHaveBeenCalledOnce();
});

it("revokes a role and uses the returned role list", async () => {
  updateUserRoleAction.mockResolvedValue({ ok: true, user: { id: userId, roles: [] } });
  const dialog = openDialog();
  fireEvent.click(within(roleRow(dialog, "Member")).getByRole("button", { name: "Remove" }));

  await waitFor(() => expect(within(roleRow(dialog, "Member")).getByRole("button", { name: "Assign" })).toBeTruthy());
  expect(updateUserRoleAction).toHaveBeenCalledExactlyOnceWith({ userId, role: "member", operation: "revoke" });
  expect(success).toHaveBeenCalledOnce();
});

it("keeps state unchanged for final-active-admin", async () => {
  updateUserStatusAction.mockResolvedValue({ ok: false, reason: "final-active-admin" });
  const dialog = openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Suspend user" }));

  await waitFor(() => expect(error).toHaveBeenCalledWith("At least one active administrator must remain."));
  expect(within(dialog).getByText("Active")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Suspend user" })).toBeTruthy();
  expect(dialog.hasAttribute("open")).toBe(true);
});

it("shows the not-found message", async () => {
  updateUserRoleAction.mockResolvedValue({ ok: false, reason: "not-found" });
  const dialog = openDialog();
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));

  await waitFor(() => expect(error).toHaveBeenCalledWith("This user no longer exists."));
  expect(dialog.hasAttribute("open")).toBe(true);
});

it("shows the invalid-input message", async () => {
  updateUserRoleAction.mockResolvedValue({ ok: false, reason: "invalid-input" });
  const dialog = openDialog();
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));

  await waitFor(() => expect(error).toHaveBeenCalledWith("Invalid user update."));
});

it("shows a generic message for an unexpected error", async () => {
  updateUserStatusAction.mockRejectedValue(new Error("private database detail"));
  const dialog = openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Suspend user" }));

  await waitFor(() => expect(error).toHaveBeenCalledWith("Unable to update user. Please try again."));
  expect(error).not.toHaveBeenCalledWith("private database detail");
  expect(dialog.hasAttribute("open")).toBe(true);
});

it("closes from the Close button", () => {
  const dialog = openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(dialog.hasAttribute("open")).toBe(false);
});

it("disables mutation controls and prevents duplicate requests while pending", async () => {
  let resolveMutation: (value: unknown) => void = () => {};
  updateUserStatusAction.mockImplementation(() => new Promise((resolve) => { resolveMutation = resolve; }));
  const dialog = openDialog();
  const suspend = within(dialog).getByRole("button", { name: "Suspend user" });
  fireEvent.click(suspend);

  expect(suspend.hasAttribute("disabled")).toBe(true);
  expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(suspend);
  expect(updateUserStatusAction).toHaveBeenCalledOnce();

  resolveMutation({ ok: true, user: { id: userId, status: "suspended" } });
  await waitFor(() => expect(within(dialog).getByText("Suspended")).toBeTruthy());
});

it("synchronizes local state when refreshed user props arrive", async () => {
  const view = render(<UserManagementDialog user={user} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
  const dialog = screen.getByRole("dialog");

  view.rerender(<UserManagementDialog user={{ ...user, status: "suspended", roles: ["coach", "member"] }} />);
  await waitFor(() => expect(within(dialog).getByText("Suspended")).toBeTruthy());
  expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" })).toBeTruthy();
  expect(dialog.hasAttribute("open")).toBe(true);
});
