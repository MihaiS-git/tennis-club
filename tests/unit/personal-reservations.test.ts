import { expect, it } from "vitest";
import { isReservationUpcoming, type PersonalReservation } from "@/lib/reservations/personal";

const base: PersonalReservation = {
  id: "a", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z",
  booking_date: "2026-10-02", starts_at_minute: 900, ends_at_minute: 960,
  reason: "Practice", status: "active", created_by_user_id: "owner", creator_name: "Ana",
  cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2",
};

it("keeps current and future active intervals actionable in each location's timezone", () => {
  const now = new Date("2026-10-02T12:30:00Z");
  expect(isReservationUpcoming(base, now)).toBe(true);
  expect(isReservationUpcoming({ ...base, ends_at_minute: 930 }, now)).toBe(false);
  expect(isReservationUpcoming({ ...base, status: "cancelled" }, now)).toBe(false);
  expect(isReservationUpcoming({ ...base, booking_date: "2026-10-03" }, now)).toBe(true);
  expect(isReservationUpcoming({ ...base, location_timezone: "America/New_York", starts_at_minute: 540, ends_at_minute: 600 }, now)).toBe(true);
});
