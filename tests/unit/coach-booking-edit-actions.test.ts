import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ change: vi.fn(), load: vi.fn(), revalidate: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/bookings/coach-edit", () => ({ changeCoachBooking: mocks.change, loadCoachBookingEditor: mocks.load }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: mocks.revalidate }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.detail }));
import { changeCoachBookingAction, loadCoachBookingEditorAction } from "@/app/coach/bookings/lessons/[bookingId]/actions";
const id = "ad000000-0000-4000-8000-000000000001";
const input = { id, expectedRevisionId: id, expectedUpdatedAt: "2099-01-01T00:00:00.123456Z", locationId: id, courtId: id,
  date: "2099-10-15", startMinute: 600, overrideCoachRestrictions: true };
beforeEach(() => vi.resetAllMocks());
test("loading uses only the Coach-authorized service", async () => {
  mocks.load.mockResolvedValue({ booking: { id } });
  expect(await loadCoachBookingEditorAction(id)).toEqual({ booking: { id } });
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(id);
});
test.each([[false, true, false], [true, false, false], [true, true, true]])("save=%s ok=%s invalidates only accepted saves", async (save, ok, invalidates) => {
  const result = ok ? { ok: true, adjustmentStatus: "pending" } : { ok: false, reason: "stale" };
  mocks.change.mockResolvedValue(result);
  expect(await changeCoachBookingAction({ ...input, save })).toBe(result);
  expect(mocks.revalidate).toHaveBeenCalledTimes(invalidates ? 1 : 0);
  expect(mocks.detail.mock.calls).toEqual(invalidates ? [[`/coach/bookings/lessons/${id}`], [`/admin/bookings/${id}`]] : []);
});
