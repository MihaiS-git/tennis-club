import { expect, test } from "vitest";
import { timestampToEpochMicroseconds } from "@/lib/precise-time";
import { paymentTransition } from "@/lib/payments/domain";

test.each([
  ["1970-01-01T00:00:01Z", BigInt(1_000_000)],
  ["1970-01-01T00:00:01.123Z", BigInt(1_123_000)],
  ["1970-01-01T00:00:01.123456Z", BigInt(1_123_456)],
  ["1970-01-01T00:00:01.000000Z", BigInt(1_000_000)],
  ["1970-01-01T00:00:01.1Z", BigInt(1_100_000)],
  ["1970-01-01T00:00:01.12Z", BigInt(1_120_000)],
  ["1970-01-01T00:00:01.1234Z", BigInt(1_123_400)],
  ["1970-01-01T00:00:01.12345Z", BigInt(1_123_450)],
  ["1970-01-01T00:00:01.1234569Z", BigInt(1_123_456)],
  ["1970-01-01T02:30:01.123456+02:30", BigInt(1_123_456)],
  ["1969-12-31T18:30:01.123456-05:30", BigInt(1_123_456)],
  ["1970-01-01T00:00:01.123456+00:00", BigInt(1_123_456)],
  ["1970-01-02T00:00:00.000001Z", BigInt(86_400_000_001)],
  ["1970-01-01T00:00:00.000001+01:00", BigInt(-3_599_999_999)],
  ["1970-01-01T23:59:59.999999-01:00", BigInt(89_999_999_999)],
  ["1969-12-31T23:59:59.999999Z", BigInt(-1)],
  // Date.parse's existing boundary normalization remains authoritative.
  ["1970-01-01T24:00:00Z", BigInt(86_400_000_000)],
])("converts %s to %s epoch microseconds", (value, expected) => {
  expect(timestampToEpochMicroseconds(value)).toBe(expected);
});

test.each(["", "invalid", "1970-13-01T00:00:00Z", "1970-01-01T00:00:00.Z",
  "1970-01-01T00:00:00+25:00", "1970-01-01T00:00:00.123456+00:60"])(
  "retains RangeError for unparseable input %s", value => {
    expect(() => timestampToEpochMicroseconds(value)).toThrow(RangeError);
  },
);

test.each([
  ["2099-10-14T23:59:59.999999Z", BigInt(-1), "succeeded"],
  ["2099-10-15T00:00:00.000000Z", BigInt(0), "expired"],
  ["2099-10-15T00:00:00.000001Z", BigInt(1), "expired"],
] as const)("preserves exact deadline comparison at %s", (now, difference, result) => {
  const deadline = "2099-10-15T00:00:00+00:00";
  expect(timestampToEpochMicroseconds(now) - timestampToEpochMicroseconds(deadline)).toBe(difference);
  expect(paymentTransition({ attemptStatus: "pending", bookingStatus: "pending_payment",
    reservationStatus: "held", reservationExpiry: deadline,
    attemptExpiry: "2099-10-15T00:00:00.000001Z", now, outcome: "succeeded" }).result).toBe(result);
});

test("payment settlement uses the earlier attempt deadline without losing microseconds", () => {
  expect(paymentTransition({ attemptStatus: "pending", bookingStatus: "pending_payment",
    reservationStatus: "held", reservationExpiry: "2099-10-15T00:00:00.000002Z",
    attemptExpiry: "2099-10-15T00:00:00.000001Z", now: "2099-10-15T00:00:00.000001Z",
    outcome: "succeeded" }).result).toBe("expired");
});
