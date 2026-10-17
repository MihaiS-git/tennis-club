// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { CalendarControls } from "@/app/book/calendar-controls";
import { ReservationControls } from "@/app/admin/reservations/reservation-controls";

afterEach(() => { cleanup(); push.mockClear(); });
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

it("book shows the selected day with its weekday, relative day and timezone", () => {
  const { rerender } = render(<CalendarControls locations={locations} locationId="rivus" date="2026-10-02" today="2026-10-02" timezone="Europe/Bucharest" />);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Friday, 2 October 2026");
  expect(screen.getByText("Today")).toBeTruthy();
  expect(screen.getByText("Times shown in Europe/Bucharest.")).toBeTruthy();
  rerender(<CalendarControls locations={locations} locationId="rivus" date="2026-10-03" today="2026-10-02" timezone="Europe/Bucharest" />);
  expect(screen.getByText("Tomorrow")).toBeTruthy();
  rerender(<CalendarControls locations={locations} locationId="rivus" date="2026-10-05" today="2026-10-02" timezone="Europe/Bucharest" />);
  expect(screen.queryByText(/^(Today|Tomorrow)$/)).toBeNull();
});
