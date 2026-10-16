import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), check: vi.fn() }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/payments/checkout", () => ({ checkOnlinePayment: mocks.check }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { checkAdminPaymentWithProvider } from "@/lib/payments/admin";
const attemptId = "ce000000-0000-4000-8000-000000000001";
afterEach(() => vi.resetAllMocks());

test("payment recovery authorizes Admin before contacting Stripe", async () => {
  mocks.authorize.mockRejectedValue(new Error("forbidden"));
  await expect(checkAdminPaymentWithProvider({ attemptId })).rejects.toThrow("forbidden");
  expect(mocks.check).not.toHaveBeenCalled();
});

test("unreachable Stripe produces a visible sanitized recovery failure", async () => {
  mocks.check.mockRejectedValue(new Error("private Stripe response"));
  const result = await checkAdminPaymentWithProvider({ attemptId });
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining("accepted occupancy stays protected") });
  expect(JSON.stringify(result)).not.toContain("private Stripe response");
});

test.each(["succeeded", "cancelled", "processing"])("Admin payment check returns Stripe outcome %s", async status => {
  mocks.check.mockResolvedValue(status);
  expect(await checkAdminPaymentWithProvider({ attemptId })).toEqual({ ok: true, status });
  expect(mocks.check).toHaveBeenCalledWith(attemptId);
});
