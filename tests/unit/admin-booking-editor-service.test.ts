import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), source: vi.fn(), snapshot: vi.fn(), run: vi.fn(),
  details: vi.fn(), tokens: vi.fn(), locations: vi.fn(), courts: vi.fn(), coaches: vi.fn() }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: mocks.source }));
vi.mock("@/lib/db/transaction", () => ({ inReadSnapshot: mocks.snapshot }));
vi.mock("@/lib/db/repositories/bookings.repository", () => ({ findAdminBookingDetails: mocks.details, findAdminBookingEditTokens: mocks.tokens }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ listAdminLocations: mocks.locations, listAdminCourts: mocks.courts }));
vi.mock("@/lib/db/repositories/coaching.repository", () => ({ listCoachProfiles: mocks.coaches }));
vi.mock("@/lib/bookings/reschedule", () => ({ runOperationalBookingChange: mocks.run }));
import { changeAdminBooking, loadAdminBookingEditor } from "@/lib/bookings/admin-edit";
const id = "ad000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.resetAllMocks(); mocks.authorize.mockResolvedValue({ userId: "verified-admin" }); mocks.snapshot.mockImplementation(fn => fn({})); });
test.each(["customer", "coach", "suspended", "anonymous"])("%s cannot read options or change a booking", async () => {
  mocks.authorize.mockRejectedValue(new Error("not authorized"));
  await expect(loadAdminBookingEditor(id)).rejects.toThrow("not authorized");
  await expect(changeAdminBooking({ id })).rejects.toThrow("not authorized");
  expect(mocks.snapshot).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.source).not.toHaveBeenCalled();
});
test("Admin commands use the verified actor and operational capacity", async () => {
  const input = { id, actorId: "forged" };
  mocks.run.mockResolvedValue({ ok: false, reason: "invalid_target" });
  expect(await changeAdminBooking(input)).toEqual({ ok: false, reason: "invalid_target" });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith(input, "verified-admin", "admin");
});
test("options include unpublished active locations and eligible Coaches irrespective of program assignments", async () => {
  mocks.details.mockResolvedValue({ includes_coaching: true, status: "confirmed", location_timezone: "UTC", booking_date: "2099-01-01", starts_at_minute: 600 }); mocks.tokens.mockResolvedValue({ updated_at: "precise" });
  mocks.locations.mockResolvedValue([{ id: "a", name: "Active private", isActive: true }, { id: "b", isActive: false }]);
  mocks.courts.mockResolvedValue([{ id: "c", name: "Active", locationId: "a", isActive: true }, { id: "d", locationId: "a", isActive: false }]);
  mocks.coaches.mockResolvedValue([{ user_id: "coach", display_name: "Coach", account_status: "active", has_coach_role: true, program_ids: [] },
    { user_id: "suspended", account_status: "suspended", has_coach_role: true }]);
  expect(await loadAdminBookingEditor(id)).toMatchObject({ locations: [{ id: "a", courts: [{ id: "c" }] }], coaches: [{ id: "coach", name: "Coach" }] });
});
