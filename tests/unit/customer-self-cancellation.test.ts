import { expect, test } from "vitest";
import { customerBookingNoticeBypass, customerCancellationEligibility, customerCancellationNoticeLabel } from "@/lib/bookings/self-cancellation";

const booking = { starts_at_instant: "2026-10-15T10:00:00+03:00", cancellation_notice_minutes: 120 };
test("snapshot cutoff is inclusive and uses elapsed minutes from the timezone-resolved instant", () => {
  expect(customerBookingNoticeBypass([])).toBe(false);
  expect(customerBookingNoticeBypass(["admin"])).toBe(true);
  expect(customerBookingNoticeBypass(["coach"])).toBe(true);
  expect(customerCancellationEligibility(booking, false, new Date("2026-10-15T04:59:59.999Z"))).toBe("eligible");
  expect(customerCancellationEligibility(booking, false, new Date("2026-10-15T05:00:00Z"))).toBe("eligible");
  expect(customerCancellationEligibility(booking, false, new Date("2026-10-15T05:00:00.001Z"))).toBe("notice_required");
  expect(customerCancellationEligibility(booking, true, new Date("2026-10-15T06:59:59.999Z"))).toBe("eligible");
  for (const staff of [false, true]) {
    expect(customerCancellationEligibility(booking, staff, new Date("2026-10-15T07:00:00Z"))).toBe("started");
    expect(customerCancellationEligibility({ ...booking, cancellation_notice_minutes: 0 }, staff,
      new Date("2026-10-15T07:00:00Z"))).toBe("started");
  }
  // PostgreSQL supplies the standard-time occurrence during the autumn overlap.
  expect(customerCancellationEligibility({ starts_at_instant: "2026-10-25T03:30:00+02:00",
    cancellation_notice_minutes: 120 }, false, new Date("2026-10-24T23:30:00Z"))).toBe("eligible");
});
test("policy context uses the booking's notice in hours or minutes", () => {
  expect(customerCancellationNoticeLabel(1440)).toBe("24 hours' notice");
  expect(customerCancellationNoticeLabel(90)).toBe("90 minutes' notice");
});
