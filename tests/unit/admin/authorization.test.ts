import { beforeEach, expect, it, vi } from "vitest";

import type { CurrentAccount, readCurrentAccount as readAccount } from "../../../src/lib/auth/account";

const { readCurrentAccount, notFound, redirect } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));

vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("next/navigation", () => ({ notFound, redirect }));

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

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([{ roles: ["coach"] }] satisfies { roles: ("coach")[] }[])("rejects an active %s account", async ({ roles }) => {
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

it("redirects an unauthenticated account to login", async () => {
  readCurrentAccount.mockResolvedValue({ state: "unauthenticated" } satisfies CurrentAccount);

  await expect(requireActiveAdmin(client)).rejects.toThrow("redirect:/login");
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
  expect(notFound).not.toHaveBeenCalled();
});

it.each(["admin", "coach"] as const)("allows active %s into the management shell with role-aware navigation", async (role) => {
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "staff", roles: [role] });
  const shell = await AdminLayout({ children: "Reservations" });
  expect(shell.props.isAdmin).toBe(role === "admin");
  expect(shell.props.children).toBe("Reservations");
  await expect(AdminPage()).rejects.toThrow(`redirect:${role === "admin" ? "/admin/locations" : "/admin/reservations"}`);
});

it.each([
  [{ state: "active", userId: "member", roles: [] }, "notFound"],
  [{ state: "unauthenticated" }, "redirect:/login"],
  [{ state: "suspended", userId: "staff", roles: ["coach"] }, "notFound"],
])("denies management shell access for %j", async (account, error) => {
  readCurrentAccount.mockResolvedValue(account);
  await expect(AdminLayout({ children: "Private" })).rejects.toThrow(error);
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
