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
import { AdminEntryRedirect } from "../../src/app/admin/admin-entry-redirect";

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

// Compile-time contract, enforced by `npm run typecheck` rather than registered as a runtime case:
// an explicit Admin role flag is required; the Coach area link is opt-in.
expectTypeOf<ComponentProps<typeof AdminNavigation>>().toEqualTypeOf<{ isAdmin: boolean; isCoach?: boolean }>();

it.each([
  ["/admin/locations", "Locations"],
  ["/admin/locations/location-id", "Locations"],
  ["/admin/payments/transactions", "Transactions"],
  ["/admin/payments/settings", "Payment settings"],
  ["/admin/bookings", "Bookings & Reservations"],
  ["/admin/bookings/booking-id", "Bookings & Reservations"],
  ["/admin/bookings/reservations/reservation-id", "Bookings & Reservations"],
  ["/admin/payments/transactions/refund/transaction-id", "Transactions"],
  ["/admin/users/user-id", "Users"],
  ["/admin/coaching/programs", "Programs"],
  ["/admin/coaching/coaches", "Coaches"],
  ["/admin/coaching/availability", "Coach availability"],
  ["/admin/users", "Users"],
  ["/admin/club", "Club"],
])("activates only %s's primary section", (pathname, label) => {
  navigation.pathname = pathname;
  render(<AdminNavigation isAdmin={true} />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(["Bookings & Reservations", "Transactions", "Users", "Locations", "Programs", "Coaches", "Coach availability", "Payment settings", "Club"]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/admin/bookings", "/admin/payments/transactions", "/admin/users", "/admin/locations", "/admin/coaching/programs", "/admin/coaching/coaches", "/admin/coaching/availability", "/admin/payments/settings", "/admin/club"]);
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
  [true, false], [false, true], [true, true],
] as const)("groups every destination once (Admin: %s, Coach: %s)", (isAdmin, isCoach) => {
  navigation.pathname = "/coach/pricing";
  render(<AdminNavigation isAdmin={isAdmin} isCoach={isCoach} />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  const operations = within(nav).getByRole("region", { name: "Operations" });
  const configuration = within(nav).getByRole("region", { name: "Configuration" });
  const hrefs = (element: HTMLElement) => within(element).getAllByRole("link").map((link) => link.getAttribute("href"));
  expect(hrefs(operations)).toEqual([
    ...(isAdmin ? ["/admin/bookings", "/admin/payments/transactions", "/admin/users"] : ["/coach/bookings"]),
    ...(isCoach ? ["/coach/availability"] : []),
  ]);
  expect(hrefs(configuration)).toEqual([
    ...(isAdmin ? ["/admin/locations", "/admin/coaching/programs", "/admin/coaching/coaches", "/admin/coaching/availability", "/admin/payments/settings", "/admin/club"] : []),
    ...(isCoach ? ["/coach/pricing"] : []),
  ]);
  expect(new Set(hrefs(nav)).size).toBe(hrefs(nav).length);
  expect(within(nav).getAllByRole("link", { name: "Bookings & Reservations" })).toHaveLength(1);
  for (const heading of within(nav).getAllByRole("heading")) {
    expect(heading.hasAttribute("tabindex")).toBe(false);
    expect(heading.hasAttribute("aria-current")).toBe(false);
  }
  expect(within(nav).queryByText("Payments", { exact: true })).toBeNull();
});

it.each([
  ["/admin/coaching/programs", true],
  ["/admin/coaching/programs/program-id", true],
  ["/admin/coaching/coaches/coach-id", true],
  // Club prices are configured in Programs; there is no separate Prices destination.
  ["/admin/coaching/prices", false],
  ["/admin/coaching/programs-extra", false],
  ["/admin/coaching/availability", true],
  ["/admin/coaching/availability-extra", false],
  ["/admin/coaching", false],
])("keeps Coaching expanded and highlights only its configuration destinations on %s", (pathname, active) => {
  navigation.pathname = pathname;
  render(<AdminNavigation isAdmin />);
  const configuration = screen.getByRole("region", { name: "Configuration" });
  const coaching = within(configuration).getByText("Coaching", { exact: true });
  expect(coaching.classList.contains("text-primary")).toBe(active);
  expect(within(configuration).queryByRole("button")).toBeNull();
  for (const label of ["Programs", "Coaches", "Coach availability"]) {
    expect(within(configuration).getByRole("link", { name: label })).toBeDefined();
  }
});

it.each([
  ["/coach/availability", "My availability"],
  ["/coach/pricing", "My prices"],
  ["/coach/bookings/reservations/reservation-id", "Bookings & Reservations"],
  ["/coach/bookings/lessons/lesson-id", "Bookings & Reservations"],
] as const)("activates only the Coach destination on %s", (pathname, label) => {
  navigation.pathname = pathname;
  render(<AdminNavigation isAdmin={false} isCoach />);
  expect(screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current")).map((link) => link.textContent)).toEqual([label]);
});

it.each([
  ["/admin/payments/transactions", "Transactions", "Payment settings"],
  ["/admin/payments/settings", "Payment settings", "Transactions"],
])("activates the correct payment destination on %s without a Payments navigation group", async (pathname, active, inactive) => {
  navigation.pathname = pathname;
  render(<><AdminNavigation isAdmin={true} />{await PaymentsLayout({ children: <p>Settings content</p> })}</>);
  expect(screen.queryByRole("link", { name: "Payments" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Payments navigation" })).toBeNull();
  expect(screen.getByRole("link", { name: active }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: inactive }).hasAttribute("aria-current")).toBe(false);
});

it("redirects the Admin entry route to Locations after authorization", async () => {
  navigation.requireReservationRole.mockResolvedValue({ roles: ["admin"] });
  await AdminEntryRedirect();
  expect(navigation.requireReservationRole).toHaveBeenCalledOnce();
  expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith("/admin/locations");
  expect(navigation.requireReservationRole.mock.invocationCallOrder[0]).toBeLessThan(navigation.redirect.mock.invocationCallOrder[0]);
});

it("does not redirect when Admin authorization rejects access", async () => {
  navigation.requireReservationRole.mockRejectedValueOnce(new Error("Unauthorized"));
  await expect(AdminEntryRedirect()).rejects.toThrow("Unauthorized");
  expect(navigation.redirect).not.toHaveBeenCalled();
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
  [true, ["Bookings & Reservations", "Transactions", "Users", "My availability", "Locations", "Programs", "Coaches", "Coach availability", "Payment settings", "Club", "My prices"]],
] as const)("adds the Coach area for coaches (Admin: %s)", (isAdmin, labels) => {
  navigation.pathname = "/coach/availability";
  render(<AdminNavigation isAdmin={isAdmin} isCoach />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(labels);
  expect(within(nav).getByRole("link", { name: "My availability" })).toMatchObject({ pathname: "/coach/availability" });
  expect(within(nav).getByRole("link", { name: "My availability" }).getAttribute("aria-current")).toBe("page");
  expect(within(nav).getByRole("link", { name: "My prices" })).toMatchObject({ pathname: "/coach/pricing" });
});

it.each([
  [true, false, "Club"], [false, true, "My prices"], [true, true, "My prices"],
] as const)("traps focus across both sections and restores it on Escape (Admin: %s, Coach: %s)", (isAdmin, isCoach, lastLabel) => {
  render(<AdminNavigation isAdmin={isAdmin} isCoach={isCoach} />);
  const trigger = screen.getByRole("button", { name: "Management menu" });
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Management menu" });
  const close = within(drawer).getByRole("button", { name: "Close management menu" });
  expect(document.activeElement).toBe(close);
  const last = within(drawer).getByRole("link", { name: lastLabel });
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");
});

it("closes on browser history navigation without storing the pathname", () => {
  render(<AdminNavigation isAdmin />);
  const trigger = screen.getByRole("button", { name: "Management menu" });
  fireEvent.click(trigger);
  fireEvent.popState(window);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(trigger);
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
  [true, "/admin/unknown", "Bookings & Reservations"],
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
  act(() => { Object.assign(desktop, { matches: true }); desktop.dispatchEvent(Object.assign(new Event("change"), { matches: true })); });
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
  act(() => { Object.assign(desktop, { matches: true }); desktop.dispatchEvent(Object.assign(new Event("change"), { matches: true })); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(destination);
  expect(focus).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe("");
});

it("redirects the Coach entry route to the Coach Bookings & Reservations area after authorization", async () => {
  navigation.requireReservationRole.mockResolvedValue({ roles: ["coach"] });
  await AdminEntryRedirect();
  expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith("/coach/bookings");
});
