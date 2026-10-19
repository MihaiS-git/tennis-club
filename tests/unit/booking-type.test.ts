import { expect, test } from "vitest";
import { bookingType, bookingTypeDetail, bookingTypeLabel } from "@/lib/bookings/booking-type";
import { courtActivityType } from "@/lib/bookings/history";

test.each([false, true])("Admin and personal activity classify the stored coaching flag consistently (%s)", (includes_coaching) => {
  const snapshot = { includes_coaching, coach_name: "Stored coach", coaching_program_name: "Stored program", total_amount_minor: 18000 };
  const expected = includes_coaching ? "coaching" : "court";
  expect(bookingType(snapshot)).toBe(expected);
  expect(courtActivityType({ kind: "booking", ...snapshot })).toBe(expected);
  expect(bookingTypeLabel(snapshot)).toBe(includes_coaching ? "Coaching" : "Court");
  expect(bookingTypeDetail(snapshot)).toBe(includes_coaching ? "Stored coach · Stored program" : undefined);
  expect(bookingType({ ...snapshot, coach_name: null, coaching_program_name: null })).toBe(expected);
});
