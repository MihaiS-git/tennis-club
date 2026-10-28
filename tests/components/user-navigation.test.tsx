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
import MessagesLayout from "../../src/app/messages/layout";

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

it("reserves the mobile drawer trigger's height while the sidebar is suspended", () => {
  // Content below the sidebar must not move when the trigger replaces the fallback.
  navigation.suspended = true;
  const { unmount } = render(<ProfileLayout><p>Profile details</p></ProfileLayout>);
  const fallback = screen.getByRole("status").className.split(" ");
  unmount();
  navigation.suspended = false;
  render(<ProfileLayout><p>Profile details</p></ProfileLayout>);
  const trigger = screen.getByRole("button", { name: "My account menu" }).className.split(" ");
  for (const sizing of ["mb-5", "max-lg:min-h-11"]) {
    expect(trigger).toContain(sizing);
    expect(fallback).toContain(sizing);
  }
});

it.each([
  ["/my-activity/bookings", "Bookings"],
  ["/my-activity/history", "Booking history"],
  ["/profile", "Player identity"],
  ["/profile/personal", "Personal information"],
  ["/profile/tennis", "Tennis profile"],
  ["/profile/security", "Account & security"],
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

it.each(["/profile-extra", "/my-activity", "/my-activity/notifications", "/messages", "/messages/message-id"])("does not activate a destination for %s", (pathname) => {
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
  render(<UserNavigation />);
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
  fireEvent.popState(window);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(trigger);
});

it("closes the drawer when resizing to desktop", () => {
  const desktop = new EventTarget();
  vi.stubGlobal("matchMedia", vi.fn(() => desktop));
  navigation.pathname = "/profile/security";
  render(<UserNavigation />);
  fireEvent.click(screen.getByRole("button", { name: "My account menu" }));
  act(() => { Object.assign(desktop, { matches: true }); desktop.dispatchEvent(Object.assign(new Event("change"), { matches: true })); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Account & security" }));
});

it("closes the drawer when a confirmed draft departure navigates outside the link handler", () => {
  navigation.pathname = "/profile/personal";
  const { rerender } = render(<UserNavigation />);
  const trigger = screen.getByRole("button", { name: "My account menu" });
  fireEvent.click(trigger);
  within(screen.getByRole("dialog", { name: "My account menu" })).getByRole("link", { name: "Tennis profile" }).focus();
  // The draft confirmation invokes router.push itself after preventing the link event.
  navigation.pathname = "/profile/tennis";
  rerender(<UserNavigation />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(trigger);
});

it.each([
  ["My activity", MyActivityLayout],
  ["Profile", ProfileLayout],
])("renders the %s layout inside the shared user sidebar shell", (heading, Layout) => {
  render(<Layout><p>Page content</p></Layout>);
  expect(screen.getByRole("heading", { level: 1, name: heading })).toBeDefined();
  expect(screen.getByRole("navigation", { name: "My account navigation" })).toBeDefined();
  expect(screen.getByText("Page content")).toBeDefined();
  expect(screen.queryByRole("link", { name: "Notifications" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "My activity navigation" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Profile settings" })).toBeNull();
});

it.each(["/messages", "/messages/message-id"])("renders Notifications on %s as a standalone section without the My account sidebar", (pathname) => {
  navigation.pathname = pathname;
  render(<MessagesLayout><h1>Notifications</h1></MessagesLayout>);
  expect(screen.getByRole("main")).toBeDefined();
  expect(screen.getByRole("heading", { level: 1, name: "Notifications" })).toBeDefined();
  expect(screen.queryByRole("navigation", { name: "My account navigation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "My account menu" })).toBeNull();
  expect(screen.queryByText("Loading account navigation…")).toBeNull();
});
