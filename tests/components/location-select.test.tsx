// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { CalendarControls } from "@/app/book/calendar-controls";
import { ReservationControls } from "@/app/reservations/reservation-controls";
import { LocationSelect } from "@/components/location-select";

afterEach(() => { cleanup(); push.mockClear(); });
const locations = [{ id: "rivus", name: "RIVUS" }, { id: "second", name: "Second" }];

it("shows the shared selector on /book even for one location", () => {
  render(<CalendarControls locations={locations.slice(0, 1)} locationId="rivus" date={null} today="2026-10-02" />);
  expect(screen.getByRole("combobox", { name: "Location" })).toHaveProperty("value", "rivus");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-03" } });
  expect(push).toHaveBeenCalledWith("/book?location=rivus&date=2026-10-03");
});

it.each([
  ["book", CalendarControls, "/book?location=second"],
  ["reservations", ReservationControls, "/reservations?location=second"],
])("%s changes location through the shared selector and clears the prior date", (_name, Controls, expected) => {
  render(<Controls locations={locations} locationId="rivus" date="2026-10-03" today="2026-10-02" />);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "second" } });
  expect(push).toHaveBeenCalledWith(expected);
});

it("owns accessible labeling and an empty disabled state", () => {
  render(<LocationSelect id="empty-location" locations={[]} selectedId="" onChange={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Location" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("option", { name: "No locations available" })).toBeTruthy();
});
