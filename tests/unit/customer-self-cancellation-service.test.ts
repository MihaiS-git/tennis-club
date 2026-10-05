import { createClient, PostgrestError } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
const { account, bookings } = vi.hoisted(() => ({ account: vi.fn(), bookings: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/bookings/personal-service", () => ({ listOwnUpcomingCustomerBookings: bookings }));
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";

const id = "ce000000-0000-4000-8000-000000000301";
const client = createClient("http://127.0.0.1:54321", "test-key", { auth: { persistSession: false } });
const rpc = vi.spyOn(client, "rpc");
beforeEach(() => {
  account.mockReset(); bookings.mockReset(); rpc.mockReset();
  account.mockResolvedValue({ state: "active", userId: "owner", roles: [] });
  bookings.mockResolvedValue([{ id, starts_at_instant: "2099-10-15T10:00:00Z", cancellation_notice_minutes: 120 }]);
});

test.each(["unavailable", "started", "notice_required"])("translates authoritative stale result %s into a safe failure", async (data) => {
  rpc.mockResolvedValue({ data, success: true, error: null, count: null, status: 200, statusText: "OK" });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false, message: expect.any(String) });
  expect(rpc).toHaveBeenCalledWith("cancel_own_customer_booking", { p_id: id });
});
test("validates identity and ownership without calling mutation for an invalid or missing owned booking", async () => {
  expect(await cancelOwnCustomerBooking({ id, account_user_id: "other" }, client)).toMatchObject({ ok: false });
  expect(account).not.toHaveBeenCalled();
  bookings.mockResolvedValue([]);
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(rpc).not.toHaveBeenCalled();
  account.mockResolvedValue({ state: "suspended", userId: "owner", roles: ["admin"] });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(rpc).not.toHaveBeenCalled();
});
test("returns safe errors for infrastructure failures and unknown results", async () => {
  rpc.mockResolvedValue({ data: null, success: false, error: new PostgrestError({ code: "XX000", message: "private SQL detail", details: "private", hint: "private" }),
    count: null, status: 500, statusText: "Error" });
  expect(await cancelOwnCustomerBooking(id, client)).toEqual({ ok: false, message: "Unable to cancel this booking. Try again." });
  rpc.mockResolvedValue({ data: true, success: true, error: null, count: null, status: 200, statusText: "OK" });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
});
