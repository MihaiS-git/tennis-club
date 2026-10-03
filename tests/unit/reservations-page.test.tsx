import { expect, it, vi } from "vitest";

const { loadDay, loadLocations } = vi.hoisted(() => ({ loadDay: vi.fn(), loadLocations: vi.fn() }));
vi.mock("@/lib/reservations/service", () => ({ getReservationDay: loadDay, listInternalLocations: loadLocations }));

import { ReservationContent } from "@/app/reservations/page";
import { ReservationControls } from "@/app/reservations/reservation-controls";

const eligible = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "Europe/Bucharest", courts: [] };

it("uses an eligible fallback for a stale location id", async () => {
  loadLocations.mockResolvedValue([eligible]);
  loadDay.mockClear();
  const content = await ReservationContent({ searchParams: Promise.resolve({ location: "stale" }) });
  expect(content.props.children[0].type).toBe(ReservationControls);
  expect(content.props.children[0].props.locationId).toBe(eligible.id);
  expect(loadDay).not.toHaveBeenCalled();
});

it("shows a configured-location empty state", async () => {
  loadLocations.mockResolvedValue([]);
  loadDay.mockClear();
  const content = await ReservationContent({ searchParams: Promise.resolve({ location: "stale" }) });
  expect(content.props.children).toContain("No configured locations are available for reservations.");
  expect(loadDay).not.toHaveBeenCalled();
});
