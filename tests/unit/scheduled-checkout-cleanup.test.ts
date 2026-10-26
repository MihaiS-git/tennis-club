import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ expire: vi.fn(), list: vi.fn(), check: vi.fn(), error: vi.fn(), manager: {} }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: mocks.manager }) }));
vi.mock("@/lib/db/repositories/payments.repository", () => ({ listOverdueStripeCheckouts: mocks.list }));
vi.mock("@/lib/payments/hold-expiry", () => ({ expirePaymentHolds: mocks.expire }));
vi.mock("@/lib/payments/checkout", () => ({ checkOnlinePayment: mocks.check }));
vi.mock("@/lib/logger", () => ({ logger: { error: mocks.error } }));
import { cleanupScheduledCheckouts } from "@/lib/payments/scheduled-checkout-cleanup";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.expire.mockResolvedValue(0);
  mocks.list.mockResolvedValue([{ id: "previously-expired" }, { id: "overdue-pending" }]);
});

test("an idle local sweep still checks overdue intents after expiry commits, without capture or processing cancellation", async () => {
  mocks.list.mockImplementation(async () => {
    expect(mocks.expire).toHaveResolved();
    return [{ id: "previously-expired" }, { id: "overdue-pending" }];
  });
  expect(await cleanupScheduledCheckouts()).toBe(0);
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(mocks.manager, 5);
  expect(mocks.check.mock.calls).toEqual([["previously-expired", true], ["overdue-pending", true]]);
});

test("provider failure leaves that intent retryable and does not prevent other checks or local cleanup", async () => {
  mocks.expire.mockResolvedValue(2);
  mocks.check.mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValueOnce("cancelled");
  expect(await cleanupScheduledCheckouts()).toBe(2);
  expect(mocks.check).toHaveBeenCalledTimes(2);
  expect(mocks.error).toHaveBeenCalledOnce();
});
