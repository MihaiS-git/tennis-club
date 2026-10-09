import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
const { account, command } = vi.hoisted(() => ({ account: vi.fn(), command: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/bookings/cancellation-service", () => ({ cancelBookingCommand: command }));
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";

const id = "ce000000-0000-4000-8000-000000000301";
const client = createClient("http://127.0.0.1:54321", "test-key", { auth: { persistSession: false } });

beforeEach(() => {
  vi.clearAllMocks();
  account.mockResolvedValue({ state: "active", userId: "owner", roles: [] });
});

test.each(["notice_required"])("translates authoritative stale result %s into a safe failure", async (data) => {
  command.mockResolvedValue({ outcome: data, refund_id: null });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false, message: expect.any(String) });
  expect(command).toHaveBeenCalledWith(id, "owner", false, null);
});
test("validates identity before the owner-checked transaction without loading Upcoming", async () => {
  expect(await cancelOwnCustomerBooking({ id, account_user_id: "other" }, client)).toMatchObject({ ok: false });
  expect(account).not.toHaveBeenCalled();
  command.mockResolvedValue({ outcome: "unavailable", refund_id: null });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(command).toHaveBeenCalledWith(id, "owner", false, null);
  command.mockClear();
  account.mockResolvedValue({ state: "suspended", userId: "owner", roles: ["admin"] });
  expect(await cancelOwnCustomerBooking(id, client)).toMatchObject({ ok: false });
  expect(command).not.toHaveBeenCalled();
});
