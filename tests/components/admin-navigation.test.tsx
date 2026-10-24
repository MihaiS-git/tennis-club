// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { ComponentProps } from "react";

const navigation = vi.hoisted(() => ({ pathname: "/admin/locations", push: vi.fn(), redirect: vi.fn(), requireActiveAdmin: vi.fn(), requireReservationRole: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: navigation.redirect, usePathname: () => navigation.pathname, useRouter: () => ({ push: navigation.push }) }));
vi.mock("../../src/lib/admin/authorization", () => ({ requireActiveAdmin: navigation.requireActiveAdmin }));
vi.mock("../../src/lib/reservations/authorization", () => ({ requireReservationRole: navigation.requireReservationRole }));
vi.mock("../../src/lib/supabase/server", () => ({ createClient: vi.fn() }));
import { AdminNavigation } from "../../src/components/admin-navigation";
import PaymentsLayout from "../../src/app/admin/payments/layout";
import AdminPage from "../../src/app/admin/page";
import { PricingLocationSelect } from "../../src/app/admin/pricing/location-select";

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

// Compile-time contract, enforced by `npm run typecheck` rather than registered as a runtime case:
// an explicit Admin role flag is required; the Coach area link is opt-in.
expectTypeOf<ComponentProps<typeof AdminNavigation>>().toEqualTypeOf<{ isAdmin: boolean; isCoach?: boolean }>();

it.each([
  ["/admin/locations", "Locations"],
  ["/admin/locations/location-id", "Locations"],
  ["/admin/payments/transactions", "Transactions"],
  ["/admin/payments/settings", "Settings"],
  ["/admin/bookings", "Bookings & Reservations"],
  ["/admin/coaching/programs", "Programs"],
  ["/admin/coaching/coaches", "Coaches"],
  ["/admin/coaching/prices", "Prices"],
  ["/admin/coaching/availability", "Availability"],
  ["/admin/users", "Users"],
  ["/admin/club", "Club"],
])("activates only %s's primary section", (pathname, label) => {
  navigation.pathname = pathname;
  render(<AdminNavigation isAdmin={true} />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(["Locations", "Bookings & Reservations", "Programs", "Coaches", "Prices", "Availability", "Transactions", "Settings", "Users", "Club"]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/admin/locations", "/admin/bookings", "/admin/coaching/programs", "/admin/coaching/coaches", "/admin/coaching/prices", "/admin/coaching/availability", "/admin/payments/transactions", "/admin/payments/settings", "/admin/users", "/admin/club"]);
  for (const link of links) {
    expect(link.getAttribute("aria-current")).toBe(link.textContent === label ? "page" : null);
  }
});

it.each(["/admin", "/admin/locations-extra", "/administrator", "/admin/unknown", "/admin/reservations", "/admin/payments/notifications"])(
  "does not activate a section for unrelated pathname %s", (pathname) => {
    navigation.pathname = pathname;
    render(<AdminNavigation isAdmin={true} />);
    expect(screen.getAllByRole("link").every((link) => !link.hasAttribute("aria-current"))).toBe(true);
  },
);

it.each([
  ["/admin/payments/transactions", "Transactions", "Settings"],
  ["/admin/payments/settings", "Settings", "Transactions"],
])("keeps Payments active on %s with the correct secondary tab", async (pathname, active, inactive) => {
  navigation.pathname = pathname;
  render(<><AdminNavigation isAdmin={true} />{await PaymentsLayout({ children: <p>Settings content</p> })}</>);
  expect(screen.queryByRole("link", { name: "Payments" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Payments navigation" })).toBeNull();
  expect(screen.getByRole("link", { name: active }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: inactive }).hasAttribute("aria-current")).toBe(false);
});

it("redirects the Admin entry route to Locations after authorization", async () => {
  navigation.requireReservationRole.mockResolvedValue({ roles: ["admin"] });
  await AdminPage();
  expect(navigation.requireReservationRole).toHaveBeenCalledOnce();
  expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith("/admin/locations");
  expect(navigation.requireReservationRole.mock.invocationCallOrder[0]).toBeLessThan(navigation.redirect.mock.invocationCallOrder[0]);
});

it("does not redirect when Admin authorization rejects access", async () => {
  navigation.requireReservationRole.mockRejectedValueOnce(new Error("Unauthorized"));
  await expect(AdminPage()).rejects.toThrow("Unauthorized");
  expect(navigation.redirect).not.toHaveBeenCalled();
});

it("navigates pricing location selection directly to the workspace tab", () => {
  const id = "a1000000-0000-4000-8000-000000000001";
  render(<PricingLocationSelect locations={[{ id, name: "Central", is_active: true }]} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: id } });
  expect(navigation.push).toHaveBeenLastCalledWith(`/admin/locations/${id}?tab=pricing`);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "" } });
  expect(navigation.push).toHaveBeenLastCalledWith("/admin/locations");
});

it("shows Coaches only their own Bookings & Reservations area", () => {
  navigation.pathname = "/coach/bookings/lessons/booking-id";
  render(<AdminNavigation isAdmin={false} />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Bookings & Reservations"]);
  const link = within(nav).getByRole("link", { name: "Bookings & Reservations" });
  expect(link).toMatchObject({ pathname: "/coach/bookings" });
  expect(link.getAttribute("aria-current")).toBe("page");
});

it.each([
  [false, ["Bookings & Reservations", "My availability", "My prices"]],
  [true, ["Locations", "Bookings & Reservations", "Programs", "Coaches", "Prices", "Availability", "Transactions", "Settings", "Users", "Club", "My availability", "My prices"]],
] as const)("adds the Coach area for coaches (Admin: %s)", (isAdmin, labels) => {
  navigation.pathname = "/coach/availability";
  render(<AdminNavigation isAdmin={isAdmin} isCoach />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(labels);
  expect(within(nav).getByRole("link", { name: "My availability" })).toMatchObject({ pathname: "/coach/availability" });
  expect(within(nav).getByRole("link", { name: "My availability" }).getAttribute("aria-current")).toBe("page");
  expect(within(nav).getByRole("link", { name: "My prices" })).toMatchObject({ pathname: "/coach/pricing" });
});

it("closes the drawer with Escape and restores focus", () => {
  render(<AdminNavigation isAdmin={true} />);
  const trigger = screen.getByRole("button", { name: "Management menu" });
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Management menu" });
  const close = within(drawer).getByRole("button", { name: "Close management menu" });
  expect(document.activeElement).toBe(close);
  const last = within(drawer).getByRole("link", { name: "Club" });
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");
});

it("closes after navigation and browser route changes", () => {
  const { rerender } = render(<AdminNavigation isAdmin={true} />);
  fireEvent.click(screen.getByRole("button", { name: "Management menu" }));
  fireEvent.click(screen.getByRole("link", { name: "Users" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Management menu" }));
  navigation.pathname = "/admin/payments/settings";
  rerender(<AdminNavigation isAdmin={true} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
});

it.each(["backdrop", "close button"])("closes with the %s and restores focus and scrolling", (control) => {
  render(<AdminNavigation isAdmin={true} />);
  const trigger = screen.getByRole("button", { name: "Management menu" });
  fireEvent.click(trigger);
  expect(document.body.style.overflow).toBe("hidden");
  const button = control === "backdrop"
    ? screen.getByLabelText("Close management backdrop")
    : screen.getByRole("button", { name: "Close management menu" });
  fireEvent.click(button);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");
});

it.each([
  [true, "/admin/users", "Users"],
  [false, "/coach/bookings", "Bookings & Reservations"],
  [true, "/admin/unknown", "Locations"],
] as const)("moves hidden mobile-control focus to a desktop destination (Admin: %s, path: %s)", (isAdmin, pathname, label) => {
  const desktop = new EventTarget();
  const matchMedia = vi.fn(() => desktop);
  vi.stubGlobal("matchMedia", matchMedia);
  navigation.pathname = pathname;
  render(<AdminNavigation isAdmin={isAdmin} />);
  const trigger = screen.getByRole("button", { name: "Management menu" });
  fireEvent.click(trigger);
  expect(matchMedia).toHaveBeenCalledWith("(min-width: 1024px)");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close management menu" }));
  act(() => { desktop.dispatchEvent(Object.assign(new Event("change"), { matches: true })); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: label }));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.style.overflow).toBe("");
});

it("preserves focus on a visible destination when resizing to desktop", () => {
  const desktop = new EventTarget();
  vi.stubGlobal("matchMedia", vi.fn(() => desktop));
  navigation.pathname = "/admin/users";
  render(<AdminNavigation isAdmin={true} />);
  fireEvent.click(screen.getByRole("button", { name: "Management menu" }));
  const destination = screen.getByRole("link", { name: "Bookings & Reservations" });
  destination.focus();
  const focus = vi.spyOn(destination, "focus");
  act(() => { desktop.dispatchEvent(Object.assign(new Event("change"), { matches: true })); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(destination);
  expect(focus).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe("");
});

it("redirects the Coach entry route to the Coach Bookings & Reservations area after authorization", async () => {
  navigation.requireReservationRole.mockResolvedValue({ roles: ["coach"] });
  await AdminPage();
  expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith("/coach/bookings");
});
