// @vitest-environment jsdom

import { renderToReadableStream } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { CurrentAccount } from "../../src/lib/auth/account";

const { readCurrentAccount, signOut, avatar, route } = vi.hoisted(() => ({ readCurrentAccount: vi.fn(), signOut: vi.fn(), avatar: { url: null as string | null }, route: { pathname: "/courts" } }));

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

vi.mock("../../src/app/account/actions", () => ({ signOutAction: signOut }));
vi.mock("../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../src/lib/profile/navigation", () => ({ readNavigationProfile: async () => ({
  account: await readCurrentAccount(), avatarUrl: avatar.url,
}) }));

import { MobileNavbarMenu } from "../../src/components/mobile-navbar-menu";
import { DesktopNavbar } from "../../src/components/desktop-navbar";
import { MobileNavbar } from "../../src/components/mobile-navbar";

afterEach(() => { cleanup(); avatar.url = null; signOut.mockReset(); });

it("shows signed-out links and closes on link selection or Escape", () => {
  render(<MobileNavbarMenu isAuthenticated={false} canReserve={false} />);

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
    "Courts", "Coaching", "Club", "Sign in",
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
  render(<MobileNavbarMenu isAuthenticated={false} canReserve={false} />);
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
  render(<MobileNavbarMenu isAuthenticated={false} canReserve={false} />);
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
  ["active coach", { state: "active", userId: "coach-1", email: "coach@example.com", roles: ["coach"] }, true],
  ["member", { state: "active", userId: "member-1", email: "member@example.com", roles: [] }, false],
  ["guest", { state: "unauthenticated" }, false],
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
      "Courts", "Coaching", "Club", "Admin", "Profile",
    ]);
    expect(navigation.lastElementChild?.lastElementChild?.textContent).toBe("Sign out");
    expect(within(navigation).getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/profile");
    expect(adminLink?.getAttribute("href")).toBe("/admin");
  } else {
    expect(adminLink).toBeNull();
  }
  const reservations = within(navigation).queryByRole("link", { name: "Reservations" });
  expect(reservations).toBeNull();
  // Wait for the server navbar's async account boundaries before inspecting it.
  const stream = await renderToReadableStream(<DesktopNavbar />);
  await stream.allReady;
  const desktop = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  const desktopNav = desktop.querySelector('nav[aria-label="Main navigation"]')!;
  const desktopAdmin = [...desktopNav.querySelectorAll("a")].find((link) => link.textContent === "Admin");
  expect(Boolean(desktopAdmin)).toBe(showsAdmin);
  if (showsAdmin) expect(desktopAdmin?.getAttribute("href")).toBe("/admin");
  expect([...desktopNav.querySelectorAll("a")].some((link) => link.textContent === "Reservations")).toBe(false);
});

it.each([
  ["/admin", "Admin"], ["/admin/payments/transactions", "Admin"], ["/admin/payments/settings", "Admin"], ["/admin/locations/location-id", "Admin"],
  ["/admin/reservations", "Admin"], ["/admin/reservations/day", "Admin"],
  ["/courts", "Courts"], ["/coaching/session", "Coaching"], ["/club/about", "Club"],
  ["/matches", null], ["/rankings", null],
  ["/administrator", null], ["/admin/reservations-extra", "Admin"], ["/courts-extra", null],
])("highlights a single segment-aware primary section on %s", async (pathname, active) => {
  route.pathname = pathname;
  render(<MobileNavbarMenu isAuthenticated canReserve />);
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  const nav = screen.getByRole("navigation", { name: "Mobile navigation" });
  const current = within(nav).getAllByRole("link").filter((link) => link.hasAttribute("aria-current"));
  expect(current.map((link) => link.textContent)).toEqual(active ? [active] : []);
  if (current.length) expect(current[0].className).toContain("bg-primary text-primary-foreground");
  readCurrentAccount.mockResolvedValue({ state: "active", roles: ["admin"] });
  const stream = await renderToReadableStream(<DesktopNavbar />);
  await stream.allReady;
  const desktop = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  expect([...desktop.querySelectorAll('nav[aria-label="Main navigation"] a[aria-current="page"]')].map((link) => link.textContent)).toEqual(active ? [active] : []);
});

it.each([
  ["member", { state: "active", userId: "member-1", email: "member@example.com", roles: [] }],
  ["coach", { state: "active", userId: "coach-1", email: "coach@example.com", roles: ["coach"] }],
  ["admin", { state: "active", userId: "admin-1", email: "admin@example.com", roles: ["admin"] }],
] satisfies ReadonlyArray<readonly [string, CurrentAccount]>)("links the %s avatar directly to Profile and places Sign out next to it", async (_description, account) => {
  readCurrentAccount.mockResolvedValue(account);
  avatar.url = "/profile/avatar?v=1";
  const stream = await renderToReadableStream(<DesktopNavbar />);
  await stream.allReady;
  const desktop = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  const profile = desktop.querySelector('header a[aria-label="Profile"]');
  expect(profile?.getAttribute("href")).toBe("/profile");
  expect(profile?.querySelector("img")?.getAttribute("src")).toBe("/profile/avatar?v=1");
  expect(desktop.querySelector('[aria-label="Account menu"]')).toBeNull();
  // Sign out sits immediately to the right of the avatar, outside any dropdown.
  const desktopSignOut = profile?.nextElementSibling?.querySelector("button");
  expect(profile?.nextElementSibling?.tagName).toBe("FORM");
  expect(desktopSignOut?.textContent?.trim()).toBe("Sign out");
  expect(desktopSignOut?.getAttribute("type")).toBe("submit");

  render(await MobileNavbar());
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  const drawer = screen.getByRole("dialog", { name: "Mobile navigation menu" });
  const mobileProfile = within(drawer).getByRole("link", { name: "Profile" });
  expect(mobileProfile.getAttribute("href")).toBe("/profile");
  expect(mobileProfile.querySelector("img")?.getAttribute("src")).toBe("/profile/avatar?v=1");
  expect(within(drawer).queryByRole("link", { name: "My activity" })).toBeNull();
  // Sign out is the drawer's last item and uses the existing action.
  const items = drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
  const mobileSignOut = within(drawer).getByRole("button", { name: "Sign out" });
  expect(items[items.length - 1]).toBe(mobileSignOut);
  expect(mobileSignOut.className).toContain("flex min-h-12");
  expect(mobileSignOut.className).toContain("text-sm font-medium text-primary enabled:hover:text-accent");
  await act(async () => { fireEvent.click(mobileSignOut); });
  expect(signOut).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe("false");
});

it("keeps the authenticated mobile bell beside the hamburger and outside the drawer", () => {
  render(<MobileNavbarMenu isAuthenticated canReserve={false} />);
  const bell = screen.getByRole("link", { name: /^Notifications/ });
  const trigger = screen.getByRole("button", { name: "Open menu" });
  expect(bell.nextElementSibling).toBe(trigger);
  expect(bell.getAttribute("href")).toBe("/my-activity/notifications");
  expect(bell.className).toContain("size-10");
  fireEvent.click(trigger);
  expect(within(screen.getByRole("dialog")).queryByRole("link", { name: /^Notifications/ })).toBeNull();
  expect(screen.getAllByRole("link", { name: /^Notifications/ })).toHaveLength(1);
});

it("omits the mobile bell when signed out", () => {
  render(<MobileNavbarMenu isAuthenticated={false} canReserve={false} />);
  expect(screen.queryByRole("link", { name: /^Notifications/ })).toBeNull();
});

it("places the desktop bell immediately beside the profile control for authenticated users", async () => {
  readCurrentAccount.mockResolvedValue({ state: "active", roles: [], userId: "owner" });
  const markup = await new Response(await renderToReadableStream(<DesktopNavbar />)).text();
  const container = document.createElement("div");
  container.innerHTML = markup;
  const bell = container.querySelector('a[href="/my-activity/notifications"]');
  expect(bell).not.toBeNull();
  expect(bell?.nextElementSibling?.getAttribute("href")).toBe("/profile");
});

it("gives only an active Admin the mobile two-destination bell beside the hamburger", async () => {
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "admin-1", email: "admin@example.com", roles: ["admin"] });
  render(await MobileNavbar());
  const bell = screen.getByRole("button", { name: /^Notifications/ });
  expect(bell.parentElement?.nextElementSibling).toBe(screen.getByRole("button", { name: "Open menu" }));
  expect(bell.className).toContain("size-10");
  fireEvent.click(bell);
  const panel = screen.getByRole("navigation", { name: "Notifications" });
  expect(within(panel).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["My notifications", "/my-activity/notifications"], ["Admin notifications", "/admin/payments/notifications"],
  ]);
  cleanup();
  for (const account of [
    { state: "active", userId: "coach-1", email: "coach@example.com", roles: ["coach"] },
    { state: "suspended", userId: "admin-1", email: "admin@example.com", roles: ["admin"] },
  ] satisfies CurrentAccount[]) {
    readCurrentAccount.mockResolvedValue(account);
    render(await MobileNavbar());
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
    cleanup();
  }
});

it("renders the desktop Admin bell as a closed disclosure beside the profile control", async () => {
  readCurrentAccount.mockResolvedValue({ state: "active", roles: ["admin"], userId: "admin-1", email: "admin@example.com" });
  const markup = await new Response(await renderToReadableStream(<DesktopNavbar />)).text();
  const container = document.createElement("div");
  container.innerHTML = markup;
  const bell = container.querySelector('button[aria-label^="Notifications"]');
  expect(bell?.getAttribute("aria-expanded")).toBe("false");
  expect(bell?.parentElement?.nextElementSibling?.getAttribute("href")).toBe("/profile");
  expect(container.querySelector('a[href="/admin/payments/notifications"]')).toBeNull();
});
