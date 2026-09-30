// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { CurrentAccount } from "../../src/lib/auth/account";

const { readCurrentAccount, createClient, redirect, notFound } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  createClient: vi.fn().mockResolvedValue({}),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));

vi.mock("../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("next/navigation", () => ({ redirect, notFound }));

import AdminPage from "../../src/app/admin/page";

beforeEach(() => {
  vi.clearAllMocks();
  readCurrentAccount.mockResolvedValue({
    state: "active", userId: "admin-1", email: "admin@example.com", roles: ["admin"],
  } satisfies CurrentAccount);
});
afterEach(cleanup);

it("renders the dashboard for an active admin through the existing authorization helper", async () => {
  render(await AdminPage());

  expect(createClient).toHaveBeenCalledOnce();
  expect(readCurrentAccount).toHaveBeenCalledExactlyOnceWith(await createClient.mock.results[0].value);
  expect(screen.getByRole("heading", { level: 1, name: "Club administration" })).toBeTruthy();
  expect(notFound).not.toHaveBeenCalled();
  expect(redirect).not.toHaveBeenCalled();
});

it.each([
  ["member", { state: "active", userId: "member-1", email: "member@example.com", roles: [] }],
  ["coach", { state: "active", userId: "coach-1", email: "coach@example.com", roles: ["coach"] }],
  ["suspended admin", { state: "suspended", userId: "admin-1", email: "admin@example.com", roles: ["admin"] }],
  ["account load error", { state: "load-error" }],
] satisfies ReadonlyArray<readonly [string, CurrentAccount]>)("rejects a %s with not-found", async (_label, account) => {
  readCurrentAccount.mockResolvedValue(account);

  await expect(AdminPage()).rejects.toThrow("notFound");
  expect(notFound).toHaveBeenCalledOnce();
  expect(redirect).not.toHaveBeenCalled();
});

it.each([
  { state: "unauthenticated" },
  { state: "missing-profile" },
] satisfies CurrentAccount[])("redirects $state to login", async (account) => {
  readCurrentAccount.mockResolvedValue(account);

  await expect(AdminPage()).rejects.toThrow("redirect:/login");
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
  expect(notFound).not.toHaveBeenCalled();
});

it("links management cards to implemented destinations including Pricing", async () => {
  render(await AdminPage());

  const cards = screen.getAllByRole("article");
  expect(cards).toHaveLength(5);
  for (const [title, href] of [
    ["Locations", "/admin/locations"],
    ["Courts", "/admin/courts"],
    ["Opening hours", "/admin/locations"],
    ["Users", "/admin/users"],
    ["Pricing", "/admin/pricing"],
  ]) {
    const card = cards.find((item) => within(item).queryByRole("heading", { name: title }));
    expect(card).toBeDefined();
    expect(within(card!).getByRole("link", { name: title }).getAttribute("href")).toBe(href);
  }

});

