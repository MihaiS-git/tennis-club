import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), source: vi.fn(), snapshot: vi.fn(), run: vi.fn(),
  details: vi.fn(), tokens: vi.fn(), locations: vi.fn(), courts: vi.fn(), coaches: vi.fn() }));
vi.mock("@/lib/coaching/authorization", () => ({ requireActiveCoach: mocks.authorize }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: mocks.source }));
vi.mock("@/lib/db/transaction", () => ({ inReadSnapshot: mocks.snapshot }));
vi.mock("@/lib/db/repositories/bookings.repository", () => ({ findAdminBookingDetails: mocks.details, findAdminBookingEditTokens: mocks.tokens }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ listAdminLocations: mocks.locations, listAdminCourts: mocks.courts }));
vi.mock("@/lib/db/repositories/coaching.repository", () => ({ listCoachProfiles: mocks.coaches }));
vi.mock("@/lib/bookings/reschedule", () => ({ runOperationalBookingChange: mocks.run }));
import { changeCoachBooking, loadCoachBookingEditor } from "@/lib/bookings/coach-edit";
const id = "ad000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.resetAllMocks(); mocks.authorize.mockResolvedValue({ userId: "verified-coach" }); mocks.snapshot.mockImplementation(fn => fn({})); });
test.each(["customer", "admin", "suspended", "anonymous"])("%s cannot read options or change a booking", async () => {
  mocks.authorize.mockRejectedValue(new Error("not authorized"));
  await expect(loadCoachBookingEditor(id)).rejects.toThrow("not authorized");
  await expect(changeCoachBooking({ id })).rejects.toThrow("not authorized");
  expect(mocks.snapshot).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.source).not.toHaveBeenCalled();
});
test("Coach commands use the verified actor and operational capacity", async () => {
  const input = { id, actorId: "forged" };
  mocks.run.mockResolvedValue({ ok: false, reason: "invalid_target" });
  expect(await changeCoachBooking(input)).toEqual({ ok: false, reason: "invalid_target" });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith(input, "verified-coach", "coach");
});
test("options include unpublished active locations and eligible Coaches irrespective of program assignments", async () => {
  mocks.details.mockResolvedValue({ coaching: { amountMinor: 10000 }, coach_user_id: "verified-coach", includes_coaching: true, status: "confirmed", location_timezone: "UTC", booking_date: "2099-01-01", starts_at_minute: 600 }); mocks.tokens.mockResolvedValue({ updated_at: "precise" });
  mocks.locations.mockResolvedValue([{ id: "a", name: "Active private", isActive: true }, { id: "b", isActive: false }]);
  mocks.courts.mockResolvedValue([{ id: "c", name: "Active", locationId: "a", isActive: true }, { id: "d", locationId: "a", isActive: false }]);
  mocks.coaches.mockResolvedValue([{ user_id: "coach", display_name: "Coach", account_status: "active", has_coach_role: true, program_ids: [] },
    { user_id: "suspended", account_status: "suspended", has_coach_role: true }]);
  expect(await loadCoachBookingEditor(id)).toMatchObject({ locations: [{ id: "a", courts: [{ id: "c" }] }], coaches: [{ id: "coach", name: "Coach" }] });
});

test.each([null, { coach_user_id: "other", coaching: {} }, { coach_user_id: "verified-coach", coaching: null }])("unassigned or non-lesson reads reject before resource options", async booking => {
  mocks.details.mockResolvedValue(booking);
  await expect(loadCoachBookingEditor(id)).rejects.toThrow("no longer available");
  expect(mocks.locations).not.toHaveBeenCalled();
  expect(mocks.details).toHaveBeenCalledWith({}, id, "verified-coach");
});

test("Coach editor projects only editing fields, never private financial or account data", async () => {
  mocks.details.mockResolvedValue({ id, coaching: {}, coach_user_id: "verified-coach", status: "confirmed", location_timezone: "UTC",
    booking_date: "2099-01-01", starts_at_minute: 600, account_user_id: "private", payment_method: "online", total_amount_minor: 50000 });
  mocks.tokens.mockResolvedValue({ updated_at: "precise" });
  mocks.locations.mockResolvedValue([]); mocks.courts.mockResolvedValue([]); mocks.coaches.mockResolvedValue([]);
  const result = await loadCoachBookingEditor(id);
  expect(result.actingCoachId).toBe("verified-coach");
  for (const field of ["account_user_id", "payment_method", "total_amount_minor", "payments", "refunds"]) expect(result.booking).not.toHaveProperty(field);
});

test("Coach response withholds refund and adjustment identifiers", async () => {
  mocks.run.mockResolvedValue({ ok: true, changed: false, totalAmountMinor: 10000, revisionId: id,
    adjustmentId: "private", refundIds: ["private-refund"], adjustmentStatus: "pending", refundStatus: "pending" });
  expect(await changeCoachBooking({ id })).toEqual({ ok: true, changed: false, totalAmountMinor: 10000,
    revisionId: id, adjustmentStatus: "pending", refundStatus: "pending" });
});
