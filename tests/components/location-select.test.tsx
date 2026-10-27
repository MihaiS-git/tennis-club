// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, use, useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { CalendarControls } from "@/app/book/calendar-controls";
import { ReservationControls } from "@/app/admin/reservations/reservation-controls";

afterEach(() => { cleanup(); push.mockReset(); });
const locations = [{ id: "rivus", name: "RIVUS" }, { id: "second", name: "Second" }];

it.each([
  ["book", CalendarControls, "/book?location=second"],
  ["reservations", ReservationControls, "/admin/reservations?location=second"],
])("%s changes location through the shared selector and clears the prior date", (_name, Controls, expected) => {
  render(<Controls locations={locations} locationId="rivus" date="2026-10-03" today="2026-10-02" />);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "second" } });
  expect(push).toHaveBeenCalledWith(expected);
});

it.each([
  ["book", CalendarControls, "/book"],
])("%s steps one calendar day while retaining location with its past-date policy", (name, Controls, path) => {
  const { rerender } = render(<Controls locations={locations} locationId="rivus" date={null} today="2026-10-02" />);
  expect(screen.getByRole("button", { name: "Previous day" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Next day" })).toHaveProperty("disabled", true);
  rerender(<Controls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" />);
  expect(screen.getByRole("button", { name: "Previous day" })).toHaveProperty("disabled", name === "book");
  expect(screen.getByLabelText("Date").getAttribute("min")).toBe(name === "book" ? "2026-10-02" : null);
  fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
  if (name === "reservations") {
    expect(push).toHaveBeenLastCalledWith(`${path}?location=rivus&date=2026-10-01`);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2000-01-01" } });
    expect(push).toHaveBeenLastCalledWith(`${path}?location=rivus&date=2000-01-01`);
  } else expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  expect(push).toHaveBeenLastCalledWith(`${path}?location=rivus&date=2026-10-03`);
  rerender(<Controls locations={locations} locationId="rivus" date="2026-11-01" today="2026-10-02" />);
  fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
  expect(push).toHaveBeenLastCalledWith(`${path}?location=rivus&date=2026-10-31`);
});

it("keeps the hosting Calendar tab when changing location or date", () => {
  render(<ReservationControls locations={locations} locationId="rivus" date="2026-10-03" today="2026-10-02" href="/admin/bookings?view=calendar" />);
  fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
  expect(push).toHaveBeenLastCalledWith("/admin/bookings?view=calendar&location=rivus&date=2026-10-02");
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "second" } });
  expect(push).toHaveBeenLastCalledWith("/admin/bookings?view=calendar&location=second");
});

it("book shows the selected day with its weekday, relative day and timezone", () => {
  const { rerender } = render(<CalendarControls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" timezone="Europe/Bucharest" />);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Friday, 2 October 2026");
  const relativeLine = screen.getByText("Today");
  expect(screen.getByText("Times shown in Europe/Bucharest.")).toBeTruthy();
  rerender(<CalendarControls locations={locations} locationId="rivus" date="2026-10-03" today="2026-10-02" timezone="Europe/Bucharest" />);
  expect(screen.getByText("Tomorrow")).toBeTruthy();
  rerender(<CalendarControls locations={locations} locationId="rivus" date="2026-10-05" today="2026-10-02" timezone="Europe/Bucharest" />);
  expect(screen.queryByText(/^(Today|Tomorrow)$/)).toBeNull();
  // The empty line stays rendered so the controls stacked below it on mobile keep their position.
  expect(relativeLine.isConnected).toBe(true);
  expect(relativeLine.textContent).toBe("");
});

// Stands in for the App Router: a push suspends inside the caller's transition
// until the server payload "arrives", keeping the current calendar rendered.
function pendingNavigation() {
  let arrive!: () => void;
  const payload = new Promise<void>((resolve) => { arrive = resolve; });
  let navigate!: (href: string) => void;
  function Destination() { use(payload); return null; }
  function Router({ children }: { children: ReactNode }) {
    const [href, setHref] = useState<string | null>(null);
    navigate = setHref;
    return <>{children}<Suspense fallback={null}>{href && <Destination key={href} />}</Suspense></>;
  }
  push.mockImplementation((href: string) => navigate(href));
  // Navigation must start in an awaited act so React retries the suspended render.
  const start = (event: () => void) => act(async () => event());
  return { Router, start, arrive: () => act(async () => { arrive(); await payload; }) };
}

it.each([
  ["book", CalendarControls, "Updating availability…", "/book"],
  ["reservations", ReservationControls, "Updating calendar…", "/admin/reservations"],
])("%s shows reserved pending feedback and blocks stale day steps until navigation completes", async (_name, Controls, label, path) => {
  const { Router, start, arrive } = pendingNavigation();
  const view = render(<Router><Controls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" /></Router>);
  const status = screen.getByRole("status");
  const busy = () => status.parentElement!.getAttribute("aria-busy");
  expect(status.textContent).toBe("");
  expect(busy()).toBe("false");
  const next = screen.getByRole("button", { name: "Next day" });
  await start(() => fireEvent.click(next));
  expect(push).toHaveBeenCalledExactlyOnceWith(`${path}?location=rivus&date=2026-10-03`);
  expect(status.textContent).toBe(label);
  expect(busy()).toBe("true");
  expect(next.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("button", { name: "Previous day" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByLabelText("Date")).toHaveProperty("value", "2026-10-03");
  fireEvent.click(next);
  fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
  expect(push).toHaveBeenCalledOnce();
  await arrive();
  view.rerender(<Router><Controls locations={locations} locationId="rivus" date="2026-10-03" today="2026-10-02" /></Router>);
  expect(status.textContent).toBe("");
  expect(busy()).toBe("false");
  expect(next.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(next);
  expect(push).toHaveBeenLastCalledWith(`${path}?location=rivus&date=2026-10-04`);
});

it.each([
  ["book", CalendarControls, "Updating availability…"],
  ["reservations", ReservationControls, "Updating calendar…"],
])("%s keeps the requested location selected while the new calendar loads", async (_name, Controls, label) => {
  const { Router, start, arrive } = pendingNavigation();
  render(<Router><Controls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" /></Router>);
  const select = screen.getByRole("combobox", { name: "Location" });
  await start(() => fireEvent.change(select, { target: { value: "second" } }));
  expect(select).toHaveProperty("value", "second");
  expect(screen.getByRole("status").textContent).toBe(label);
  await arrive();
  expect(screen.getByRole("status").textContent).toBe("");
});

it("ignores a repeated day step activated before the pending state renders", () => {
  render(<ReservationControls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" />);
  const next = screen.getByRole("button", { name: "Next day" });
  act(() => { next.click(); next.click(); });
  expect(push).toHaveBeenCalledExactlyOnceWith("/admin/reservations?location=rivus&date=2026-10-03");
});

it.each([
  ["book", CalendarControls, "/book"],
  ["reservations", ReservationControls, "/admin/reservations"],
])("%s keeps a pending location when the date changes before it renders", async (_name, Controls, path) => {
  const { Router, start, arrive } = pendingNavigation();
  render(<Router><Controls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" /></Router>);
  await start(() => fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "second" } }));
  await start(() => fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-05" } }));
  expect(push).toHaveBeenLastCalledWith(`${path}?location=second&date=2026-10-05`);
  expect(screen.getByRole("combobox", { name: "Location" })).toHaveProperty("value", "second");
  expect(screen.getByLabelText("Date")).toHaveProperty("value", "2026-10-05");
  await arrive();
});

it.each([
  ["book", CalendarControls, "/book"],
  ["reservations", ReservationControls, "/admin/reservations"],
])("%s lets a location change after a pending date change resolve that location's default day", async (_name, Controls, path) => {
  const { Router, start, arrive } = pendingNavigation();
  render(<Router><Controls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" /></Router>);
  await start(() => fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-05" } }));
  await start(() => fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "second" } }));
  expect(push.mock.calls).toEqual([[`${path}?location=rivus&date=2026-10-05`], [`${path}?location=second`]]);
  expect(screen.getByRole("combobox", { name: "Location" })).toHaveProperty("value", "second");
  await arrive();
});

it("book drops the prior location's lesson choices when the date changes during a pending location change", async () => {
  const { Router, start, arrive } = pendingNavigation();
  render(<Router><CalendarControls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02"
    coaching={{ program: "private", coach: "ana", duration: "90" }} /></Router>);
  await start(() => fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "second" } }));
  await start(() => fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-05" } }));
  expect(push).toHaveBeenLastCalledWith("/book?location=second&mode=coaching&date=2026-10-05");
  await arrive();
});
