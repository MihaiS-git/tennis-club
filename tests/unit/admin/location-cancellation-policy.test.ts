import { expect, test } from "vitest";
import { locationFieldsSchema } from "@/lib/admin/locations-validation";
import { cancellationNoticeMinutesSchema, defaultCustomerCancellationNoticeMinutes } from "@/lib/bookings/cancellation-policy";

test("location policy stores bounded whole elapsed minutes", () => {
  expect(defaultCustomerCancellationNoticeMinutes).toBe(1440);
  for (const value of [0, 60, 90, 120, 1440, 2880, 43200]) {
    expect(cancellationNoticeMinutesSchema.parse(value)).toBe(value);
    expect(locationFieldsSchema.shape.customer_cancellation_notice_minutes.parse(value)).toBe(value);
  }
  for (const value of [-1, 43201, 1.5, NaN, Infinity, "120", null, undefined])
    expect(cancellationNoticeMinutesSchema.safeParse(value).success).toBe(false);
});
