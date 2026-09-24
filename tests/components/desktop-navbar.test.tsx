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
    roles: ["member"],
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
