import { beforeEach, expect, test, vi } from "vitest";
const { cancel, revalidate } = vi.hoisted(() => ({ cancel: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/bookings/self-cancellation-service", () => ({ cancelOwnCustomerBooking: cancel }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
import { cancelOwnCustomerBookingAction } from "@/app/my-activity/bookings/actions";
beforeEach(() => { cancel.mockReset(); revalidate.mockReset(); });
test("refreshes personal activity, History and occupancy only after a lifecycle transition", async () => {
  cancel.mockResolvedValue({ ok: true });
  expect(await cancelOwnCustomerBookingAction("booking")).toEqual({ ok: true });
  expect(cancel).toHaveBeenCalledWith("booking");
  expect(revalidate.mock.calls).toEqual([["/book"], ["/reservations"], ["/my-activity/bookings"], ["/my-activity/bookings/history"]]);
  revalidate.mockClear();
  cancel.mockResolvedValue({ ok: false, message: "No longer available." });
  expect(await cancelOwnCustomerBookingAction("booking")).toEqual({ ok: false, message: "No longer available." });
  expect(revalidate).not.toHaveBeenCalled();
});
test("does not expose unexpected service errors", async () => {
  cancel.mockRejectedValue(new Error("private database detail"));
  expect(await cancelOwnCustomerBookingAction("booking")).toEqual({ ok: false, message: "Unable to cancel this booking. Try again." });
  expect(revalidate).not.toHaveBeenCalled();
});
