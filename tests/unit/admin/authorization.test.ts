import { beforeEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

import type { CurrentAccount, readCurrentAccount as readAccount } from "../../../src/lib/auth/account";

const { readCurrentAccount, notFound, redirect, managementShell } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  managementShell: vi.fn((props: { children: ReactNode; isAdmin: boolean; isCoach: boolean }) => props.children),
}));

vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("../../../src/components/management-shell", () => ({ ManagementShell: managementShell }));

vi.mock("../../../src/lib/supabase/server", () => ({ createClient: vi.fn(async () => client) }));
import AdminLayout from "../../../src/app/admin/layout";
import AdminPage from "../../../src/app/admin/page";
import LocationsLayout from "../../../src/app/admin/locations/layout";
import CourtsLayout from "../../../src/app/admin/courts/layout";
import PricingLayout from "../../../src/app/admin/pricing/layout";
import UsersLayout from "../../../src/app/admin/users/layout";
import PaymentsLayout from "../../../src/app/admin/payments/layout";
import { requireActiveAdmin } from "../../../src/lib/admin/authorization";

const client = {} as Parameters<typeof readAccount>[0];

async function renderAdminLayout(children: string) {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(createElement(AdminLayout, null, children), {
    onError: (error) => { errors.push(error); },
  });
  await stream.allReady;
  await new Response(stream).text();
  if (errors.length) throw errors[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([{ roles: [] }, { roles: ["coach"] }] satisfies { roles: ("coach")[] }[])("rejects an active %s account", async ({ roles }) => {
  readCurrentAccount.mockResolvedValue({
    state: "active", userId: "user-1", email: "user@example.com", roles: [...roles],
  } satisfies CurrentAccount);

  await expect(requireActiveAdmin(client)).rejects.toThrow("notFound");
  expect(notFound).toHaveBeenCalledOnce();
  expect(redirect).not.toHaveBeenCalled();
});

it("rejects a suspended admin account", async () => {
  readCurrentAccount.mockResolvedValue({
    state: "suspended", userId: "admin-1", email: "admin@example.com", roles: ["admin"],
  } satisfies CurrentAccount);

  await expect(requireActiveAdmin(client)).rejects.toThrow("notFound");
  expect(notFound).toHaveBeenCalledOnce();
  expect(redirect).not.toHaveBeenCalled();
});

it.each(["unauthenticated", "missing-profile"] as const)("redirects a %s account to login", async (state) => {
  readCurrentAccount.mockResolvedValue({ state } satisfies CurrentAccount);

  await expect(requireActiveAdmin(client)).rejects.toThrow("redirect:/login");
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
  expect(notFound).not.toHaveBeenCalled();
});

it.each([{ roles: ["admin"] }, { roles: ["coach", "admin"] }] satisfies { roles: ("admin" | "coach")[] }[])("allows active Admin roles %j", async ({ roles }) => {
  const account = { state: "active", userId: "admin-1", email: "admin@example.com", roles } satisfies CurrentAccount;
  readCurrentAccount.mockResolvedValue(account);

  await expect(requireActiveAdmin(client)).resolves.toBe(account);
  expect(readCurrentAccount).toHaveBeenCalledExactlyOnceWith(client);
  expect(redirect).not.toHaveBeenCalled();
  expect(notFound).not.toHaveBeenCalled();
});

it("rejects an account load-error without redirecting", async () => {
  readCurrentAccount.mockResolvedValue({ state: "load-error" } satisfies CurrentAccount);

  await expect(requireActiveAdmin(client)).rejects.toThrow("notFound");
  expect(notFound).toHaveBeenCalledOnce();
  expect(redirect).not.toHaveBeenCalled();
});

it("propagates account-loading exceptions", async () => {
  const error = new Error("Account unavailable");
  readCurrentAccount.mockRejectedValueOnce(error);

  await expect(requireActiveAdmin(client)).rejects.toBe(error);
  expect(notFound).not.toHaveBeenCalled();
  expect(redirect).not.toHaveBeenCalled();
});

it.each(["admin", "coach"] as const)("allows active %s into the management shell with role-aware navigation", async (role) => {
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "staff", roles: [role] });
  await renderAdminLayout("Reservations");
  expect(managementShell.mock.calls[0][0]).toEqual({
    isAdmin: role === "admin", isCoach: role === "coach", children: "Reservations",
  });
  await expect(AdminPage()).rejects.toThrow(`redirect:${role === "admin" ? "/admin/locations" : "/coach/bookings"}`);
});

it("preserves both role flags and Admin entry precedence for a Coach who is also an Admin", async () => {
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "staff", roles: ["coach", "admin"] });
  await renderAdminLayout("Bookings");
  expect(managementShell.mock.calls[0][0]).toEqual({ isAdmin: true, isCoach: true, children: "Bookings" });
  await expect(AdminPage()).rejects.toThrow("redirect:/admin/locations");
});

it.each([
  [{ state: "active", userId: "member", roles: [] }, "notFound"],
  [{ state: "unauthenticated" }, "redirect:/login"],
  [{ state: "suspended", userId: "staff", roles: ["coach"] }, "notFound"],
])("denies management shell access for %j", async (account, error) => {
  readCurrentAccount.mockResolvedValue(account);
  await expect(renderAdminLayout("Private")).rejects.toThrow(error);
  expect(managementShell).not.toHaveBeenCalled();
  await expect(AdminPage()).rejects.toThrow(error);
});

it.each([LocationsLayout, CourtsLayout, PricingLayout, UsersLayout, PaymentsLayout])(
  "keeps Admin-only sections guarded on direct navigation", async (layout) => {
    readCurrentAccount.mockResolvedValue({ state: "active", userId: "coach", roles: ["coach"] });
    await expect(layout({ children: "Private" })).rejects.toThrow("notFound");
    readCurrentAccount.mockResolvedValue({ state: "active", userId: "admin", roles: ["admin"] });
    await expect(layout({ children: "Private" })).resolves.toBeDefined();
  },
);
