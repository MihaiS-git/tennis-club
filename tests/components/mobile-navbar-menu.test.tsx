// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { CurrentAccount } from "../../src/lib/auth/account";

const { readCurrentAccount, avatar } = vi.hoisted(() => ({ readCurrentAccount: vi.fn(), avatar: { url: null as string | null } }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

vi.mock("../../src/app/account/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../src/lib/profile/navigation", () => ({ readNavigationProfile: async () => ({
  account: await readCurrentAccount(), avatarUrl: avatar.url,
}) }));

import { MobileNavbarMenu } from "../../src/components/mobile-navbar-menu";
import { MobileNavbar } from "../../src/components/mobile-navbar";

afterEach(() => { cleanup(); avatar.url = null; });

it("shows signed-out links and closes on link selection or Escape", () => {
  render(<MobileNavbarMenu isAuthenticated={false} isAdmin={false} canReserve={false} />);

  const trigger = screen.getByRole("button", { name: "Open menu" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("dialog", { name: "Mobile navigation menu" })).toBeNull();

  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Mobile navigation menu" });
  const navigation = within(drawer).getByRole("navigation", { name: "Mobile navigation" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-controls")).toBe(drawer.id);
  expect(drawer.getAttribute("aria-modal")).toBe("true");
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "Close menu" }));
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Courts", "Coaching", "Rankings", "Club", "Sign in",
  ]);
  expect(within(navigation).queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(within(navigation).queryByText("Book a court")).toBeNull();

  fireEvent.click(within(navigation).getByRole("link", { name: "Courts" }));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");

  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("closes on backdrop or drawer close button and restores focus", () => {
  render(<MobileNavbarMenu isAuthenticated={false} isAdmin={false} canReserve={false} />);
  const trigger = screen.getByRole("button", { name: "Open menu" });

  fireEvent.click(trigger);
  fireEvent.click(document.querySelector('[aria-label="Close menu backdrop"]')!);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close menu" }));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("keeps keyboard focus inside the open drawer", () => {
  render(<MobileNavbarMenu isAuthenticated={false} isAdmin={false} canReserve={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

  const drawer = screen.getByRole("dialog", { name: "Mobile navigation menu" });
  const closeButton = within(drawer).getByRole("button", { name: "Close menu" });
  const lastLink = within(drawer).getByRole("link", { name: "Sign in" });

  fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(lastLink);

  fireEvent.keyDown(lastLink, { key: "Tab" });
  expect(document.activeElement).toBe(closeButton);
});

it.each([
  ["active admin", { state: "active", userId: "admin-1", email: "admin@example.com", roles: ["admin"] }, true],
  ["suspended admin", { state: "suspended", userId: "admin-1", email: "admin@example.com", roles: ["admin"] }, false],
] satisfies ReadonlyArray<readonly [string, CurrentAccount, boolean]>)("shows Admin only for %s in the mobile navbar", async (_description, account, showsAdmin) => {
  readCurrentAccount.mockResolvedValue(account);
  render(await MobileNavbar());
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

  const navigation = within(screen.getByRole("dialog", { name: "Mobile navigation menu" }))
    .getByRole("navigation", { name: "Mobile navigation" });
  expect(within(navigation).queryByRole("link", { name: "Users" })).toBeNull();
  const links = within(navigation).getAllByRole("link");
  const adminLink = within(navigation).queryByRole("link", { name: "Admin" });
  if (showsAdmin) {
    expect(links.map((link) => link.textContent)).toEqual([
      "Courts", "Coaching", "Matches", "Rankings", "Club", "Admin", "Reservations", "My activity", "Profile & settings",
    ]);
    expect(adminLink?.getAttribute("href")).toBe("/admin/locations");
  } else {
    expect(adminLink).toBeNull();
  }
  const reservations = within(navigation).queryByRole("link", { name: "Reservations" });
  expect(reservations?.getAttribute("href") ?? null).toBe(account.state === "active" && account.roles.some((role) => role === "admin" || role === "coach") ? "/reservations" : null);
});
