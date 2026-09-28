// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { CurrentAccount } from "../../src/lib/auth/account";

const { readCurrentAccount, avatar } = vi.hoisted(() => ({ readCurrentAccount: vi.fn(), avatar: { url: null as string | null } }));

vi.mock("../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../src/lib/profile/navigation", () => ({ readNavigationProfile: async () => ({
  account: await readCurrentAccount(), avatarUrl: avatar.url,
}) }));
vi.mock("../../src/app/account/actions", () => ({ signOutAction: vi.fn() }));

import { DesktopNavbar } from "../../src/components/desktop-navbar";

beforeEach(() => readCurrentAccount.mockReset());
afterEach(() => { cleanup(); avatar.url = null; });

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
  expect(screen.queryByRole("link", { name: "Your profile" })).toBeNull();
});

it("shows Matches, Profile, and direct Sign out for authenticated users", async () => {
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
  expect(screen.getByRole("link", { name: "Your profile" }).getAttribute("href")).toBe("/profile");
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
  expect(screen.getByRole("link", { name: "Your profile" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});

it.each([null, "/profile/avatar?v=updated"])("uses a circular avatar control or the original icon button (%s)", async (src) => {
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "owner", roles: [] });
  avatar.url = src;
  render(await DesktopNavbar());
  const control = screen.getByRole("link", { name: "Your profile" });
  expect(control.getAttribute("href")).toBe("/profile");
  if (src) {
    const image = control.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(src);
    expect(image.getAttribute("alt")).toBe("");
    expect(image.hasAttribute("data-nimg")).toBe(false);
    expect(image.getAttribute("width")).toBe("36");
    expect(image.getAttribute("height")).toBe("36");
    expect(image.classList.contains("object-cover")).toBe(true);
    expect(control.classList.contains("size-9")).toBe(true);
    expect(control.classList.contains("rounded-full")).toBe(true);
    expect(control.classList.contains("rounded-control")).toBe(false);
    expect(control.classList.contains("border")).toBe(false);
    expect(control.classList.contains("focus-visible:outline-2")).toBe(true);
    expect(control.classList.contains("focus-visible:outline-offset-2")).toBe(true);
    expect(control.querySelector("svg")).toBeNull();
    fireEvent.error(image);
    expect(control.querySelector("img")).toBeNull();
  } else {
    expect(control.querySelector("img")).toBeNull();
  }
  expect(control.querySelector("svg")).not.toBeNull();
  expect(control.className).toBe("inline-flex size-10 items-center justify-center rounded-control border border-border-strong text-primary hover:bg-surface-muted hover:text-accent");
  expect(control.getAttribute("href")).toBe("/profile");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
});
