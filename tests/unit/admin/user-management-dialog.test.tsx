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
  updated_at: "2026-09-25T23:30:00-04:00",
  status: "active" as const,
  roles: ["member"] as UserRole[],
};

function openDialog(props: Parameters<typeof UserManagementDialog>[0]["user"] = user, currentAdminId = "other-admin") {
  render(<UserManagementDialog currentAdminId={currentAdminId} user={props} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
  return screen.getByRole("dialog");
}

function roleRow(dialog: HTMLElement, label: string) {
  return within(dialog).getByText(label).closest("li") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
});

afterEach(cleanup);

it("renders a single Manage button while closed", () => {
  render(<UserManagementDialog currentAdminId="other-admin" user={user} />);
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

it.each([["member"] as UserRole[], [] as UserRole[]])("shows Member as required without assignment or removal controls (%s)", (...roles) => {
  const row = roleRow(openDialog({ ...user, roles }), "Member");
  expect(within(row).getByText("Required")).toBeTruthy();
  expect(within(row).queryByRole("button")).toBeNull();
  expect(row.querySelector('[aria-busy="true"]')).toBeNull();
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
  expect(success).toHaveBeenCalledExactlyOnceWith("User suspended.");
  expect(dialog.hasAttribute("open")).toBe(true);
});

it("reactivates a suspended user and updates the displayed status", async () => {
  updateUserStatusAction.mockResolvedValue({ ok: true, user: { id: userId, status: "active" } });
  const dialog = openDialog({ ...user, status: "suspended" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Reactivate user" }));

  await waitFor(() => expect(within(dialog).getByText("Active")).toBeTruthy());
  expect(updateUserStatusAction).toHaveBeenCalledExactlyOnceWith({ userId, status: "active" });
  expect(success).toHaveBeenCalledExactlyOnceWith("User reactivated.");
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
  updateUserRoleAction.mockResolvedValue({ ok: true, user: { id: userId, roles: ["member"] } });
  const dialog = openDialog({ ...user, roles: ["coach", "member"] });
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" }));

  await waitFor(() => expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" })).toBeTruthy());
  expect(updateUserRoleAction).toHaveBeenCalledExactlyOnceWith({ userId, role: "coach", operation: "revoke" });
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
  expect(success).not.toHaveBeenCalled();
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

  expect(success).not.toHaveBeenCalled();
  expect(suspend.hasAttribute("disabled")).toBe(true);
  expect(suspend.getAttribute("aria-busy")).toBe("true");
  expect(suspend.style.cursor).toBe("wait");
  expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(suspend);
  expect(updateUserStatusAction).toHaveBeenCalledOnce();

  resolveMutation({ ok: true, user: { id: userId, status: "suspended" } });
  await waitFor(() => expect(within(dialog).getByText("Suspended")).toBeTruthy());
  expect(suspend.getAttribute("aria-busy")).toBe("false");
  expect(suspend.style.cursor).toBe("");
});

it("synchronizes local state when refreshed user props arrive", async () => {
  const view = render(<UserManagementDialog currentAdminId="other-admin" user={user} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
  const dialog = screen.getByRole("dialog");

  view.rerender(<UserManagementDialog currentAdminId="other-admin" user={{ ...user, status: "suspended", roles: ["coach", "member"] }} />);
  await waitFor(() => expect(within(dialog).getByText("Suspended")).toBeTruthy());
  expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" })).toBeTruthy();
  expect(dialog.hasAttribute("open")).toBe(true);
});

it("blocks own status and admin controls while keeping coach manageable and member required", async () => {
  const dialog = openDialog({ ...user, roles: ["admin", "member"] }, userId);
  const status = within(dialog).getByRole("button", { name: "Suspend user" });
  const admin = within(roleRow(dialog, "Admin")).getByRole("button", { name: "Remove" });
  expect(status.hasAttribute("disabled")).toBe(true);
  expect(admin.hasAttribute("disabled")).toBe(true);
  for (const control of [status, admin]) {
    expect(control.getAttribute("aria-busy")).toBe("false");
    expect(control.style.cursor).toBe("not-allowed");
  }
  fireEvent.click(status);
  fireEvent.click(admin);
  expect(updateUserStatusAction).not.toHaveBeenCalled();
  expect(updateUserRoleAction).not.toHaveBeenCalled();
  expect(within(roleRow(dialog, "Member")).getByText("Required")).toBeTruthy();
  expect(within(roleRow(dialog, "Member")).queryByRole("button")).toBeNull();

  updateUserRoleAction.mockResolvedValueOnce({ ok: true, user: { id: userId, roles: ["admin", "coach", "member"] } });
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));
  await waitFor(() => expect(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(false));
  updateUserRoleAction.mockResolvedValueOnce({ ok: true, user: { id: userId, roles: ["admin", "member"] } });
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(updateUserRoleAction).toHaveBeenLastCalledWith({ userId, role: "coach", operation: "revoke" }));
});

it("keeps another administrator's status and admin controls actionable", () => {
  const dialog = openDialog({ ...user, roles: ["admin"] });
  expect(within(dialog).getByRole("button", { name: "Suspend user" }).hasAttribute("disabled")).toBe(false);
  expect(within(roleRow(dialog, "Admin")).getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(false);
});

it("disables own admin assignment even if the displayed role list is stale", () => {
  const dialog = openDialog(user, userId);
  expect(within(roleRow(dialog, "Admin")).getByRole("button", { name: "Assign" }).hasAttribute("disabled")).toBe(true);
});

it.each(["status", "role"])("shows the specific self-management rejection for %s", async (mutation) => {
  const dialog = openDialog();
  if (mutation === "status") {
    updateUserStatusAction.mockResolvedValue({ ok: false, reason: "self-management" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspend user" }));
  } else {
    updateUserRoleAction.mockResolvedValue({ ok: false, reason: "self-management" });
    fireEvent.click(within(roleRow(dialog, "Admin")).getByRole("button", { name: "Assign" }));
  }
  await waitFor(() => expect(error).toHaveBeenCalledExactlyOnceWith(mutation === "status"
    ? "Your account status can only be changed by another administrator."
    : "Your admin role can only be changed by another administrator."));
  expect(success).not.toHaveBeenCalled();
});


it.each([
  ["admin", "Admin", "assign", "Admin role assigned."],
  ["admin", "Admin", "revoke", "Admin role removed."],
  ["coach", "Coach", "assign", "Coach role assigned."],
  ["coach", "Coach", "revoke", "Coach role removed."],
] as const)("shows %s %s %s success only after confirmation", async (role, label, operation, message) => {
  let resolveMutation: (value: unknown) => void = () => {};
  updateUserRoleAction.mockImplementationOnce(() => new Promise((resolve) => { resolveMutation = resolve; }));
  const dialog = openDialog({ ...user, roles: operation === "revoke" ? [role, "member"] : ["member"] });
  const button = within(roleRow(dialog, label)).getByRole("button", { name: operation === "assign" ? "Assign" : "Remove" });
  fireEvent.click(button);
  expect(success).not.toHaveBeenCalled();
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(dialog.hasAttribute("open")).toBe(true);

  resolveMutation({ ok: true, user: { id: userId, roles: operation === "assign" ? [role, "member"] : ["member"] } });
  await waitFor(() => expect(success).toHaveBeenCalledExactlyOnceWith(message));
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(dialog.hasAttribute("open")).toBe(true);
});


it("keeps policy-disabled controls free of loading feedback during an own coach mutation", async () => {
  let resolveMutation: (value: unknown) => void = () => {};
  updateUserRoleAction.mockImplementationOnce(() => new Promise((resolve) => { resolveMutation = resolve; }));
  const dialog = openDialog({ ...user, roles: ["admin", "member"] }, userId);
  const coach = within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" });
  fireEvent.click(coach);
  expect(coach.getAttribute("aria-busy")).toBe("true");
  expect(coach.style.cursor).toBe("wait");
  expect(within(roleRow(dialog, "Member")).queryByRole("button")).toBeNull();
  expect(roleRow(dialog, "Member").querySelector('[aria-busy="true"]')).toBeNull();
  const status = within(dialog).getByRole("button", { name: "Suspend user" });
  const admin = within(roleRow(dialog, "Admin")).getByRole("button", { name: "Remove" });
  for (const control of [status, admin]) {
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(control.getAttribute("aria-busy")).toBe("false");
    expect(control.style.cursor).toBe("not-allowed");
  }
  resolveMutation({ ok: true, user: { id: userId, roles: ["admin", "coach", "member"] } });
  await waitFor(() => expect(coach.getAttribute("aria-busy")).toBe("false"));
  expect(coach.style.cursor).toBe("");
});


it("renders Last updated in UTC and follows refreshed props while remaining open", async () => {
  const view = render(<UserManagementDialog currentAdminId="other-admin" user={user} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Last updated/)).toBeTruthy();
  const time = dialog.querySelector("time");
  expect(time?.textContent).toBe("26 Sep 2026");
  expect(time?.getAttribute("datetime")).toBe(user.updated_at);
  updateUserRoleAction.mockResolvedValueOnce({ ok: true, user: { id: userId, roles: ["coach", "member"] } });
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));
  await waitFor(() => expect(success).toHaveBeenCalledWith("Coach role assigned."));
  // The mutation response has no timestamp; only refreshed server props supply it.
  expect(time?.getAttribute("datetime")).toBe(user.updated_at);
  view.rerender(<UserManagementDialog currentAdminId="other-admin" user={{ ...user, updated_at: "2026-09-27T08:00:00+00:00" }} />);
  expect(time?.textContent).toBe("27 Sep 2026");
  expect(time?.getAttribute("datetime")).toBe("2026-09-27T08:00:00+00:00");
  expect(dialog.hasAttribute("open")).toBe(true);
});

it.each(["close", "escape", "unmount"])("restores previous document scrolling on %s", (method) => {
  document.body.style.overflow = "auto";
  document.documentElement.style.overflow = "scroll";
  const view = render(<UserManagementDialog currentAdminId="other-admin" user={user} />);
  try {
    expect(document.body.style.overflow).toBe("auto");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    const dialog = screen.getByRole("dialog");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");
    // These two layout constraints preserve internal scrolling on short viewports.
    expect(dialog.classList.contains("overflow-y-auto")).toBe(true);
    expect(dialog.classList.contains("max-h-[calc(100dvh-2rem)]")).toBe(true);
    if (method === "close") fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    else if (method === "escape") {
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
      dialog.removeAttribute("open"); // jsdom does not implement the native Escape default.
    } else view.unmount();
    expect(document.body.style.overflow).toBe("auto");
    expect(document.documentElement.style.overflow).toBe("scroll");
  } finally {
    view.unmount();
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
  }
});


it("shows the specific member-role-required result without success feedback", async () => {
  updateUserRoleAction.mockResolvedValueOnce({ ok: false, reason: "member-role-required" });
  const dialog = openDialog();
  // Exercise the shared result handler; the UI never generates a member revoke.
  fireEvent.click(within(roleRow(dialog, "Coach")).getByRole("button", { name: "Assign" }));
  await waitFor(() => expect(error).toHaveBeenCalledWith("The member role is required for every account."));
  expect(success).not.toHaveBeenCalled();
});
