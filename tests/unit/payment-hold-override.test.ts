import { expect, test } from "vitest";
import { modificationHoldDurationSeconds, paymentHoldDurationSeconds, paymentHoldSeconds } from "@/lib/payments/domain";

test("the hold override is honored only in tests or with the explicit E2E flag, never in production", () => {
  // Initial checkout holds last five minutes; modification cutoffs keep ten.
  expect(paymentHoldDurationSeconds).toBe(300);
  expect(modificationHoldDurationSeconds).toBe(600);
  expect(paymentHoldSeconds({})).toBe(600);
  expect(paymentHoldSeconds({ NODE_ENV: "test", BOOKING_HOLD_SECONDS_OVERRIDE: "60" })).toBe(60);
  expect(paymentHoldSeconds({ NODE_ENV: "development", BOOKING_HOLD_SECONDS_OVERRIDE: "60" })).toBe(600);
  expect(paymentHoldSeconds({ NODE_ENV: "development", E2E_ALLOW_HOLD_OVERRIDE: "1", BOOKING_HOLD_SECONDS_OVERRIDE: "60" })).toBe(60);
  expect(paymentHoldSeconds({ NODE_ENV: "production", E2E_ALLOW_HOLD_OVERRIDE: "1", BOOKING_HOLD_SECONDS_OVERRIDE: "60" })).toBe(600);
  // It can only shorten the hold, within sane bounds.
  for (const value of ["5", "601", "abc", "1.5"]) expect(paymentHoldSeconds({ NODE_ENV: "test", BOOKING_HOLD_SECONDS_OVERRIDE: value })).toBe(600);
});
