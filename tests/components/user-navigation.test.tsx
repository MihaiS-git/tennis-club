// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/my-activity/bookings", suspended: false }));
vi.mock("next/navigation", () => ({ usePathname: () => {
  if (navigation.suspended) throw new Promise(() => {});
  return navigation.pathname;
}, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { AdminNavigation } from "../../src/components/admin-navigation";
import { UserNavigation } from "../../src/components/user-navigation";
import { UserAreaShell } from "../../src/components/management-shell";
import MyActivityLayout from "../../src/app/my-activity/layout";
import ProfileLayout from "../../src/app/profile/layout";

afterEach(() => { cleanup(); navigation.suspended = false; vi.clearAllMocks(); vi.unstubAllGlobals(); });

const labels = ["Bookings", "Booking history", "Player identity", "Personal information", "Tennis profile", "Account & security"];
const hrefs = ["/my-activity/bookings", "/my-activity/history", "/profile", "/profile/personal", "/profile/tennis", "/profile/security"];

it("isolates a suspended dynamic pathname to the sidebar while keeping the page visible", () => {
  navigation.suspended = true;
  render(<MyActivityLayout><p>Booking details</p></MyActivityLayout>);
  expect(screen.getByRole("status").textContent).toBe("Loading account navigation…");
  expect(screen.getByRole("heading", { name: "My activity" })).toBeDefined();
  expect(screen.getByText("Booking details")).toBeDefined();
});

it.each([
  ["/my-activity/bookings", "Bookings", "My activity"],
  ["/my-activity/history", "Booking history", "My activity"],
  ["/profile", "Player identity", "Profile & settings"],
  ["/profile/personal", "Personal information", "Profile & settings"],
  ["/profile/tennis", "Tennis profile", "Profile & settings"],
  ["/profile/security", "Account & security", "Profile & settings"],
])("lists every destination and activates only %s", (pathname, label, heading) => {
  navigation.pathname = pathname;
  render(<UserNavigation />);
  const nav = screen.getByRole("navigation", { name: "My account navigation" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(labels);
  expect(links.map((link) => link.getAttribute("href"))).toEqual(hrefs);
  for (const link of links) {
    expect(link.getAttribute("aria-current")).toBe(link.textContent === label ? "page" : null);
    expect(link.className.includes("bg-primary text-primary-foreground")).toBe(link.textContent === label);
  }
  for (const section of ["My activity", "Profile & settings"])
    expect(within(nav).getByText(section).className).toContain(section === heading ? "text-primary" : "text-muted-foreground");
});

it.each(["/profile-extra", "/my-activity", "/my-activity/bookings-extra", "/my-activity/notifications"])("does not activate a destination for %s", (pathname) => {
  navigation.pathname = pathname;
  render(<UserNavigation />);
  expect(screen.getAllByRole("link").every((link) => !link.hasAttribute("aria-current"))).toBe(true);
});

it("uses the Admin sidebar's link, group and drawer styling", () => {
  navigation.pathname = "/admin/payments/settings";
  const admin = render(<AdminNavigation isAdmin={true} />);
  const adminActive = screen.getByRole("link", { name: "Settings" }).className;
  const adminInactive = screen.getByRole("link", { name: "Transactions" }).className;
  const adminGroup = within(screen.getByRole("navigation")).getByText("Payments").className;
  const adminAside = admin.container.querySelector("aside")!.className;
  admin.unmount();
  navigation.pathname = "/my-activity/history";
  const user = render(<UserNavigation />);
  expect(screen.getByRole("link", { name: "Booking history" }).className).toBe(adminActive);
  expect(screen.getByRole("link", { name: "Bookings" }).className).toBe(adminInactive);
  expect(within(screen.getByRole("navigation")).getByText("My activity").className).toBe(adminGroup);
  expect(adminAside).toContain("hidden");
  expect(adminAside).not.toContain("translate-x");
  expect(user.container.querySelector("aside")!.className).not.toContain("hidden");
});

it("slides the mobile drawer in and out like the main mobile menu", () => {
  navigation.pathname = "/my-activity/bookings";
  const { container, rerender } = render(<UserNavigation />);
  const aside = container.querySelector("aside")!;
  const classes = () => aside.className.split(/\s+/);
  // Same direction, width, duration and easing as the main mobile navigation drawer.
  for (const token of ["max-lg:fixed", "max-lg:inset-y-0", "max-lg:left-0", "max-lg:z-50", "max-lg:h-dvh", "max-lg:w-[90vw]", "max-lg:max-w-[360px]",
    "max-lg:transition-[translate,visibility]", "max-lg:duration-[var(--ui-duration-base)]", "max-lg:ease-standard", "motion-reduce:transition-none"])
    expect(classes()).toContain(token);
  expect(classes()).toEqual(expect.arrayContaining(["max-lg:invisible", "max-lg:-translate-x-full"]));
  const trigger = screen.getByRole("button", { name: "My account menu" });
  fireEvent.click(trigger);
  expect(container.querySelector("aside")).toBe(aside);
  expect(classes()).toContain("translate-x-0");
  expect(classes()).not.toContain("max-lg:-translate-x-full");
  expect(container.querySelector('[aria-label="Close my account backdrop"]')!.className).toBe("fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px] lg:hidden");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(classes()).toEqual(expect.arrayContaining(["max-lg:invisible", "max-lg:-translate-x-full"]));
  // A route change (including Back/Forward) closes the drawer without remounting, so it can animate out.
  fireEvent.click(trigger);
  navigation.pathname = "/profile/tennis";
  rerender(<UserNavigation />);
  expect(container.querySelector("aside")).toBe(aside);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(classes()).toContain("max-lg:-translate-x-full");
  expect(document.body.style.overflow).toBe("");
});

it("does not offer Sign out in the user sidebar", () => {
  const { container } = render(<UserNavigation />);
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(container.querySelector("form")).toBeNull();
});

it("opens as a mobile drawer, traps focus and closes on navigation or Escape", () => {
  render(<UserNavigation />);
  const trigger = screen.getByRole("button", { name: "My account menu" });
  expect(trigger.className).toContain("lg:hidden");
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "My account menu" });
  const close = within(drawer).getByRole("button", { name: "Close my account menu" });
  expect(document.activeElement).toBe(close);
  expect(document.body.style.overflow).toBe("hidden");
  const last = within(drawer).getByRole("link", { name: "Account & security" });
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Tennis profile" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
});

it("closes the drawer when resizing to desktop", () => {
  const desktop = new EventTarget();
  vi.stubGlobal("matchMedia", vi.fn(() => desktop));
  navigation.pathname = "/profile/security";
  render(<UserNavigation />);
  fireEvent.click(screen.getByRole("button", { name: "My account menu" }));
  act(() => { desktop.dispatchEvent(Object.assign(new Event("change"), { matches: true })); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Account & security" }));
});

it.each([
  ["My activity", MyActivityLayout],
  ["Profile", ProfileLayout],
])("renders the %s layout inside the shared user sidebar shell", (heading, Layout) => {
  const shell = render(<UserAreaShell><p>content</p></UserAreaShell>);
  const shellGrid = shell.container.querySelector("main > div")!.className;
  shell.unmount();
  const { container } = render(<Layout><p>Page content</p></Layout>);
  expect(container.querySelector("main > div")!.className).toBe(shellGrid);
  expect(screen.getByRole("heading", { level: 1, name: heading })).toBeDefined();
  expect(screen.getByRole("navigation", { name: "My account navigation" })).toBeDefined();
  expect(screen.getByText("Page content")).toBeDefined();
  expect(screen.queryByRole("navigation", { name: "My activity navigation" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Profile settings" })).toBeNull();
});
