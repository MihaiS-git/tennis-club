// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/location-select", () => ({ LocationSelect: () => <span>Shared LocationSelect</span> }));

import { CalendarControls } from "@/app/book/calendar-controls";
import { ReservationControls } from "@/app/reservations/reservation-controls";

afterEach(cleanup);

it("renders the same LocationSelect in both page controls", () => {
  const props = { locations: [{ id: "rivus", name: "RIVUS" }], locationId: "rivus", date: null, today: "2026-10-02" };
  render(<CalendarControls {...props} />);
  expect(screen.getByText("Shared LocationSelect")).toBeTruthy();
  cleanup();
  render(<ReservationControls {...props} />);
  expect(screen.getByText("Shared LocationSelect")).toBeTruthy();
});
