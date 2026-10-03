import { beforeEach, expect, it, vi } from "vitest";

const { create, revalidate } = vi.hoisted(() => ({ create: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/bookings/service", () => ({ createCustomerBooking: create }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));

import { confirmCustomerBookingAction } from "@/app/book/actions";

const intent = { courtId: "c9000000-0000-4000-8000-000000000011", date: "2099-10-15",
  startMinute: 600, endMinute: 660, customerName: "  Guest  ",
  customerEmail: " guest@example.test ", customerPhone: " 123 ",
  expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };

beforeEach(() => { create.mockReset(); revalidate.mockReset(); });

it("validates with the booking schema and sends only customer intent to the service", async () => {
  expect(await confirmCustomerBookingAction({ ...intent, total_amount_minor: 1 })).toMatchObject({ ok: false });
  expect(create).not.toHaveBeenCalled();
  expect(await confirmCustomerBookingAction({ ...intent, customerEmail: "wrong" }))
    .toMatchObject({ ok: false, fieldErrors: { customerEmail: expect.any(String) } });
  create.mockResolvedValue({ ok: true, bookingId: "id", reservationId: "id", totalAmountMinor: 5000, currency: "RON" });
  expect(await confirmCustomerBookingAction(intent)).toEqual({ ok: true, totalAmountMinor: 5000, currency: "RON" });
  expect(create).toHaveBeenCalledWith({ ...intent, customerName: "Guest",
    customerEmail: "guest@example.test", customerPhone: "123" });
  expect(revalidate).toHaveBeenCalledWith("/book");
});

it("returns service authorization and availability failures without creating a guest fallback", async () => {
  create.mockResolvedValueOnce({ ok: false, message: "This account cannot create a booking." });
  expect(await confirmCustomerBookingAction(intent)).toEqual({ ok: false,
    message: "This account cannot create a booking.", availabilityChanged: undefined });
  create.mockResolvedValueOnce({ ok: false, availabilityChanged: true,
    message: "That court is no longer available for the selected time." });
  expect(await confirmCustomerBookingAction(intent)).toMatchObject({ ok: false, availabilityChanged: true });
  expect(revalidate).toHaveBeenCalledOnce();
});

it("passes through authoritative price changes without refreshing availability", async () => {
  create.mockResolvedValue({ ok: false, reason: "price_changed", totalAmountMinor: 6000, currency: "EUR" });
  expect(await confirmCustomerBookingAction(intent)).toEqual({ ok: false, reason: "price_changed",
    totalAmountMinor: 6000, currency: "EUR" });
  expect(revalidate).not.toHaveBeenCalled();
});
