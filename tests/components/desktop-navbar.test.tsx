// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import type { CurrentAccount } from "../../src/lib/auth/account";

const { readCurrentAccount } = vi.hoisted(() => ({ readCurrentAccount: vi.fn() }));

vi.mock("../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../src/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("../../src/app/account/actions", () => ({ signOutAction: vi.fn() }));

import { DesktopNavbar } from "../../src/components/desktop-navbar";

beforeEach(() => readCurrentAccount.mockReset());
afterEach(cleanup);

it("shows public navigation and signed-out actions", async () => {
  readCurrentAccount.mockResolvedValue({ state: "unauthenticated" } satisfies CurrentAccount);
  render(await DesktopNavbar());

  const navigation = screen.getByRole("navigation", { name: "Main navigation" });
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Courts", "Coaching", "Rankings", "Club",
  ]);
  expect(within(navigation).queryByRole("link", { name: "Matches" })).toBeNull();
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  expect(screen.getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Your account" })).toBeNull();
});

it("shows Matches, account, and direct Sign out for authenticated users", async () => {
  readCurrentAccount.mockResolvedValue({
    state: "active",
    userId: "member-1",
    email: "member@example.com",
    roles: [],
  } satisfies CurrentAccount);
  render(await DesktopNavbar());

  const navigation = screen.getByRole("navigation", { name: "Main navigation" });
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Courts", "Coaching", "Matches", "Rankings", "Club",
  ]);
  expect(screen.getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
  expect(screen.getByRole("link", { name: "Your account" }).getAttribute("href")).toBe("/account");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
});

it.each([
  ["missing profile", { state: "missing-profile" }],
  ["load error", { state: "load-error" }],
  ["active coach", { state: "active", userId: "coach-1", email: "coach@example.com", roles: ["coach"] }],
  ["suspended admin", { state: "suspended", userId: "admin-1", email: "admin@example.com", roles: ["admin"] }],
] satisfies ReadonlyArray<readonly [string, CurrentAccount]>)("does not show Users for %s", async (_description, account) => {
  readCurrentAccount.mockResolvedValue(account);
  render(await DesktopNavbar());

  const navigation = screen.getByRole("navigation", { name: "Main navigation" });
  expect(within(navigation).queryByRole("link", { name: "Users" })).toBeNull();
  expect(within(navigation).getByRole("link", { name: "Club" })).toBeTruthy();
});

it("shows Users after Club for an active admin", async () => {
  readCurrentAccount.mockResolvedValue({
    state: "active",
    userId: "admin-1",
    email: "admin@example.com",
    roles: ["admin"],
  } satisfies CurrentAccount);
  render(await DesktopNavbar());

  const navigation = screen.getByRole("navigation", { name: "Main navigation" });
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Courts", "Coaching", "Matches", "Rankings", "Club", "Users",
  ]);
  expect(within(navigation).getByRole("link", { name: "Users" }).getAttribute("href")).toBe("/admin/users");
  expect(screen.getByRole("link", { name: "Your account" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});
