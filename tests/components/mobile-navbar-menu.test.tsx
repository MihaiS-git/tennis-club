// @vitest-environment jsdom

import { renderToReadableStream } from "react-dom/server";
import { Suspense, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { CurrentAccount } from "../../src/lib/auth/account";

const { readCurrentAccount, signOut, avatar, route } = vi.hoisted(() => ({ readCurrentAccount: vi.fn(), signOut: vi.fn(), avatar: { url: null as string | null }, route: { pathname: "/courts", push: vi.fn() } }));

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useRouter: () => ({ push: route.push, replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ href, onNavigate, onClick, children, scroll, replace, transitionTypes, ...props }: Omit<ComponentProps<"a">, "href"> & {
    href: string; scroll?: boolean; replace?: boolean; transitionTypes?: string[]; onNavigate?: (event: { preventDefault: () => void }) => void;
  }) => {
    void scroll; void replace; void transitionTypes;
    return <a {...props} href={href} onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate?.({ preventDefault() {} });
    }}>{children}</a>;
  },
}));

vi.mock("../../src/app/account/actions", () => ({ signOutAction: signOut }));
vi.mock("../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../src/lib/profile/navigation", () => ({ readNavigationProfile: async () => ({
  account: await readCurrentAccount(), avatarUrl: avatar.url,
}) }));

import { MobileNavbarMenu } from "../../src/components/mobile-navbar-menu";
import { DesktopNavbar } from "../../src/components/desktop-navbar";
import { MobileNavbar } from "../../src/components/mobile-navbar";

beforeEach(() => {
  route.pathname = "/courts";
  route.push.mockReset();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => Object.assign(new EventTarget(), {
    matches: false, media: query, onchange: null,
  })));
});
afterEach(() => { cleanup(); avatar.url = null; signOut.mockReset(); vi.unstubAllGlobals(); });

it("shows signed-out links and closes after navigation settles or on Escape", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let ready = false;
  function Destination({ navigating }: { navigating: boolean }) {
    if (navigating && !ready) throw gate;
    return <p>Current page</p>;
  }
  function App() {
    const [navigating, setNavigating] = useState(false);
    // Like Next's router, push returns void and schedules a suspending React update.
    route.push.mockImplementation(() => { setNavigating(true); });
    return <Suspense fallback="Loading destination">
      <MobileNavbarMenu isAuthenticated={false} canReserve={false} />
      <Destination navigating={navigating} />
    </Suspense>;
  }
  render(<App />);

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

  const courts = within(navigation).getByRole("link", { name: "Courts" });
  courts.focus();
  fireEvent.click(courts);
  expect(route.push).toHaveBeenCalledExactlyOnceWith("/courts");
  expect(screen.getByRole("dialog", { name: "Mobile navigation menu" })).toBe(drawer);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(courts.querySelector("svg.motion-safe\\:animate-spin")).toBeTruthy();
  expect(document.activeElement).toBe(courts);
  expect(document.body.style.overflow).toBe("hidden");

  await act(async () => { ready = true; finish(); });
  expect(screen.queryByRole("dialog", { name: "Mobile navigation menu" })).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(courts.querySelector("svg.motion-safe\\:animate-spin")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");

  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("dialog", { name: "Mobile navigation menu" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");
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
  ["/coach", "Admin"], ["/coach/bookings", "Admin"], ["/coach/availability", "Admin"], ["/coach/pricing", "Admin"], ["/coaches", null],
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
  await act(async () => { fireEvent.click(mobileSignOut); });
  expect(signOut).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe("false");
});

it.each([
  { state: "active", userId: "member-1", email: "member@example.com", roles: [] },
  { state: "active", userId: "admin-1", email: "admin@example.com", roles: ["admin"] },
] satisfies CurrentAccount[])("renders a notification bell in mobile navigation (%o)", async account => {
  readCurrentAccount.mockResolvedValue(account);
  render(await MobileNavbar());
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  expect(screen.getByRole("link", { name: "Notifications" }).getAttribute("href")).toBe("/messages");
  expect(screen.queryByRole("button", { name: /Notifications/ })).toBeNull();
});

it("renders a notification bell in desktop navigation", async () => {
  readCurrentAccount.mockResolvedValue({ state: "active", roles: ["admin"], userId: "admin-1", email: "admin@example.com" });
  const markup = await new Response(await renderToReadableStream(<DesktopNavbar />)).text();
  const container = document.createElement("div");
  container.innerHTML = markup;
  expect(container.querySelector('a[href="/profile"]')).not.toBeNull();
  expect(container.querySelector('a[aria-label="Notifications"]')?.getAttribute("href")).toBe("/messages");
});

it("does not render a notification bell for guests", async () => {
  readCurrentAccount.mockResolvedValue({ state: "unauthenticated" });
  render(await MobileNavbar());
  expect(screen.queryByRole("link", { name: /Notifications/ })).toBeNull();
  const markup = await new Response(await renderToReadableStream(<DesktopNavbar />)).text();
  const desktop = new DOMParser().parseFromString(markup, "text/html");
  expect(desktop.querySelector('[aria-label^="Notifications"]')).toBeNull();
});

it.each([null, "/profile/avatar?v=1"])("shares icon geometry and interaction styles across desktop and mobile (avatar %s)", async url => {
  readCurrentAccount.mockResolvedValue({ state: "active", roles: [], userId: "member-1", email: "member@example.com" });
  avatar.url = url;
  const stream = await renderToReadableStream(<DesktopNavbar />);
  await stream.allReady;
  const desktop = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  const { container } = render(await MobileNavbar());
  const controls = [
    desktop.querySelector('a[aria-label="Notifications"]')!,
    desktop.querySelector('a[aria-label="Profile"]')!,
    container.querySelector('a[aria-label="Notifications"]')!,
  ];
  expect(container.querySelector('a[aria-label="Profile"]')).toBeNull();
  expect(controls.every(control => control.className === controls[0].className)).toBe(true);
  for (const control of controls) {
    expect(control.className).toContain("size-10 shrink-0 items-center justify-center");
    expect(control.className).toContain("p-0");
    expect(control.className).toContain("hover:bg-surface-muted active:bg-surface-muted focus-visible:outline-2");
    const icon = control.querySelector("svg, img")!;
    expect(icon.getAttribute("class")).toContain("size-5");
    if (icon.tagName.toLowerCase() === "img") {
      expect(icon.getAttribute("width")).toBe("20");
      expect(icon.getAttribute("height")).toBe("20");
    }
  }
  expect(controls.map(control => control.getAttribute("href"))).toEqual(["/messages", "/profile", "/messages"]);
});
