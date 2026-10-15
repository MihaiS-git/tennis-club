import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
const { account, command } = vi.hoisted(() => ({ account: vi.fn(), command: vi.fn<typeof import("@/lib/bookings/cancellation-service").cancelBookingCommand>() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/bookings/cancellation-service", () => ({ cancelBookingCommand: command }));
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";

const id = "ce000000-0000-4000-8000-000000000301";
const client = createClient("http://127.0.0.1:54321", "test-key", { auth: { persistSession: false } });

beforeEach(() => {
  vi.clearAllMocks();
  account.mockResolvedValue({ state: "active", userId: "owner", roles: [] });
});

test.each(["notice_required", "started", "unavailable"] as const)("translates authoritative stale result %s into a safe failure", async (data) => {
  command.mockResolvedValue({ outcome: data });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false, message: expect.any(String) });
  expect(command).toHaveBeenCalledWith(id, "owner", false);
});
test("validates identity before the owner-checked transaction without loading Upcoming", async () => {
  expect(await cancelOwnCustomerBooking({ id, account_user_id: "other" }, client)).toMatchObject({ ok: false });
  expect(account).not.toHaveBeenCalled();
  command.mockResolvedValue({ outcome: "unavailable" });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(command).toHaveBeenCalledWith(id, "owner", false);
  command.mockClear();
  account.mockResolvedValue({ state: "suspended", userId: "owner", roles: ["admin"] });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(command).not.toHaveBeenCalled();
});

test("preserves the active-account message when the locked actor becomes inactive", async () => {
  command.mockResolvedValue({ outcome: "inactive" });
  expect(await cancelOwnCustomerBooking(id, client)).toEqual({ ok: false,
    message: "An active account is required to cancel a booking." });
});
test("successful owner cancellation without refunds needs no provider", async () => {
  command.mockResolvedValue({ outcome: "cancelled", refundIds: [] });
  expect(await cancelOwnCustomerBooking(id, client)).toEqual({ ok: true, outcome: "cancelled" });
});
