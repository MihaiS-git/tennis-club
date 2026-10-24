// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/my-activity/bookings", suspended: false }));
vi.mock("next/navigation", () => ({ usePathname: () => {
  if (navigation.suspended) throw new Promise(() => {});
  return navigation.pathname;
}, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { UserNavigation } from "../../src/components/user-navigation";
import MyActivityLayout from "../../src/app/my-activity/layout";
import ProfileLayout from "../../src/app/profile/layout";

afterEach(() => { cleanup(); navigation.suspended = false; vi.clearAllMocks(); vi.unstubAllGlobals(); });

const labels = ["Notifications", "Bookings", "Booking history", "Player identity", "Personal information", "Tennis profile", "Account & security"];
const hrefs = ["/messages", "/my-activity/bookings", "/my-activity/history", "/profile", "/profile/personal", "/profile/tennis", "/profile/security"];

it("isolates a suspended dynamic pathname to the sidebar while keeping the page visible", () => {
  navigation.suspended = true;
  render(<MyActivityLayout><p>Booking details</p></MyActivityLayout>);
  expect(screen.getByRole("status").textContent).toBe("Loading account navigation…");
  expect(screen.getByRole("heading", { name: "My activity" })).toBeDefined();
  expect(screen.getByText("Booking details")).toBeDefined();
});

it.each([
  ["/my-activity/bookings", "Bookings"],
  ["/my-activity/history", "Booking history"],
  ["/profile", "Player identity"],
  ["/profile/personal", "Personal information"],
  ["/profile/tennis", "Tennis profile"],
  ["/profile/security", "Account & security"],
  ["/messages", "Notifications"],
])("lists every destination and activates only %s", (pathname, label) => {
  navigation.pathname = pathname;
  render(<UserNavigation />);
  const nav = screen.getByRole("navigation", { name: "My account navigation" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(labels);
  expect(links.map((link) => link.getAttribute("href"))).toEqual(hrefs);
  for (const link of links) {
    expect(link.getAttribute("aria-current")).toBe(link.textContent === label ? "page" : null);
  }
});

it.each(["/profile-extra", "/my-activity", "/my-activity/notifications"])("does not activate a destination for %s", (pathname) => {
  navigation.pathname = pathname;
  render(<UserNavigation />);
  expect(screen.getAllByRole("link").every((link) => !link.hasAttribute("aria-current"))).toBe(true);
});

it("does not offer Sign out in the user sidebar", () => {
  const { container } = render(<UserNavigation />);
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(container.querySelector("form")).toBeNull();
});

it("opens as a mobile drawer, traps focus and closes on navigation or Escape", () => {
  navigation.pathname = "/my-activity/bookings";
  const { rerender } = render(<UserNavigation />);
  const trigger = screen.getByRole("button", { name: "My account menu" });
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
  // A route change without a drawer click (Back/Forward) also closes it.
  fireEvent.click(trigger);
  navigation.pathname = "/profile/tennis";
  rerender(<UserNavigation />);
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
  render(<Layout><p>Page content</p></Layout>);
  expect(screen.getByRole("heading", { level: 1, name: heading })).toBeDefined();
  expect(screen.getByRole("navigation", { name: "My account navigation" })).toBeDefined();
  expect(screen.getByText("Page content")).toBeDefined();
  expect(screen.queryByRole("navigation", { name: "My activity navigation" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Profile settings" })).toBeNull();
});
