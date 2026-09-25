import { beforeEach, expect, it, vi } from "vitest";

import type { CurrentAccount, readCurrentAccount as readAccount } from "../../../src/lib/auth/account";

const { readCurrentAccount, notFound, redirect } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));

vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("next/navigation", () => ({ notFound, redirect }));

import { requireActiveAdmin } from "../../../src/lib/admin/authorization";

const client = {} as Parameters<typeof readAccount>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

it("returns an active admin account", async () => {
  const account = {
    state: "active", userId: "admin-1", email: "admin@example.com", roles: ["admin"],
  } satisfies CurrentAccount;
  readCurrentAccount.mockResolvedValue(account);

  await expect(requireActiveAdmin(client)).resolves.toBe(account);
  expect(readCurrentAccount).toHaveBeenCalledExactlyOnceWith(client);
  expect(notFound).not.toHaveBeenCalled();
  expect(redirect).not.toHaveBeenCalled();
});

it.each(["member", "coach"] as const)("rejects an active %s account", async (role) => {
  readCurrentAccount.mockResolvedValue({
    state: "active", userId: `${role}-1`, email: `${role}@example.com`, roles: [role],
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

it("redirects a missing-profile account to login", async () => {
  readCurrentAccount.mockResolvedValue({ state: "missing-profile" } satisfies CurrentAccount);

  await expect(requireActiveAdmin(client)).rejects.toThrow("redirect:/login");
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
  expect(notFound).not.toHaveBeenCalled();
});
