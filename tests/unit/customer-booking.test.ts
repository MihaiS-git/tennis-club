import { expect, test } from "vitest";
import { customerBookingInputSchema } from "@/lib/bookings/domain";

const valid = { courtId: "c9000000-0000-4000-8000-000000000011", date: "2099-10-15",
  startMinute: 600, endMinute: 660, customerName: "  Ada Lovelace  ",
  customerEmail: "  ada@example.test  ", customerPhone: "  +40 123 456  ",
  expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };

test("booking intent accepts only contact and schedule fields, preserving trimmed snapshots", () => {
  expect(customerBookingInputSchema.parse(valid)).toMatchObject({ customerName: "Ada Lovelace",
    customerEmail: "ada@example.test", customerPhone: "+40 123 456" });
  for (const extra of ["account_user_id", "created_by_user_id", "status", "price", "currency", "reservation_id"])
    expect(customerBookingInputSchema.safeParse({ ...valid, [extra]: "spoof" }).success).toBe(false);
  for (const change of [{ startMinute: 615 }, { endMinute: 630 }, { endMinute: 675 },
    { customerName: "  " }, { customerEmail: "wrong" }, { customerPhone: " " },
    { expectedTotalAmountMinor: 0 }, { expectedCurrency: "NOK" }])
    expect(customerBookingInputSchema.safeParse({ ...valid, ...change }).success).toBe(false);
});
