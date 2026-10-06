import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
const { account, bookings, command } = vi.hoisted(() => ({ account: vi.fn(), bookings: vi.fn(), command: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/bookings/personal-service", () => ({ listOwnUpcomingCustomerBookings: bookings }));
vi.mock("@/lib/bookings/cancellation-service", () => ({ cancelBookingCommand: command }));
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";

const id = "ce000000-0000-4000-8000-000000000301";
const client = createClient("http://127.0.0.1:54321", "test-key", { auth: { persistSession: false } });

beforeEach(() => {
  account.mockReset(); bookings.mockReset(); command.mockReset();
  account.mockResolvedValue({ state: "active", userId: "owner", roles: [] });
  bookings.mockResolvedValue([{ id, starts_at_instant: "2099-10-15T10:00:00Z", cancellation_notice_minutes: 120 }]);
});

test.each(["unavailable", "started", "notice_required"])("translates authoritative stale result %s into a safe failure", async (data) => {
  command.mockResolvedValue({ outcome: data, refund_id: null });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false, message: expect.any(String) });
  expect(command).toHaveBeenCalledWith(id, "owner", false, null);
});
test("validates identity and ownership before mutation; missing Upcoming rows use the owner-checked replay boundary", async () => {
  expect(await cancelOwnCustomerBooking({ id, account_user_id: "other" }, client)).toMatchObject({ ok: false });
  expect(account).not.toHaveBeenCalled();
  bookings.mockResolvedValue([]);
  command.mockResolvedValue({ outcome: "unavailable", refund_id: null });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(command).toHaveBeenCalledWith(id, "owner", false, null);
  command.mockClear();
  account.mockResolvedValue({ state: "suspended", userId: "owner", roles: ["admin"] });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(command).not.toHaveBeenCalled();
});
test("returns safe errors for infrastructure failures and unknown results", async () => {
  command.mockRejectedValueOnce(new Error("private SQL detail"));
  expect(await cancelOwnCustomerBooking(id, client)).toEqual({ ok: false, message: "Unable to cancel this booking. Try again." });
  command.mockResolvedValue(true);
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
});
