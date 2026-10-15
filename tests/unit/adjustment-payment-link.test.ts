import { createHash } from "node:crypto";
import { DataSource } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";
import type { BookingAdjustmentEntity } from "@/lib/db/entities/booking-adjustment.entity";
import type { PaymentAttemptEntity } from "@/lib/db/entities/payment-attempt.entity";
import { getDataSource } from "@/lib/db/data-source";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import { inTransaction } from "@/lib/db/transaction";
import { onlinePaymentAdapter } from "@/lib/payments/providers";
import { readAdjustmentPaymentLink } from "@/lib/payments/checkout";

vi.mock("@/lib/db/data-source");
vi.mock("@/lib/db/repositories/booking-adjustments.repository");
vi.mock("@/lib/db/transaction");
vi.mock("@/lib/payments/providers", async original => ({
  ...await original<typeof import("@/lib/payments/providers")>(), onlinePaymentAdapter: vi.fn(),
}));
const adapter = { resumePayment: vi.fn(), createPayment: vi.fn(), readPayment: vi.fn(), cancelPayment: vi.fn(), refundPayment: vi.fn() };
const source = new DataSource({ type: "postgres", url: "postgresql://unused/unused" });
const id = "da000000-0000-4000-8000-000000000001", bookingId = "da000000-0000-4000-8000-000000000002";
const token = "a".repeat(64), access = { adjustmentId: id, token };
const expiresAt = new Date("2099-10-15T10:00:00Z");
const adjustment: BookingAdjustmentEntity = {
  id, bookingId, baseRevisionId: "da000000-0000-4000-8000-000000000003", actorId: "da000000-0000-4000-8000-000000000004",
  scope: "owner", requestKey: "edit", target: { courtId: "da000000-0000-4000-8000-000000000005", date: "2099-10-16",
    startMinute: 600, endMinute: 690, expectedUpdatedAt: "2026-10-15T10:00:00Z", courtName: "Court", locationName: "Club", timezone: "UTC" },
  originalTotal: 5000, newTotal: 7500, currency: "RON", status: "pending", expiresAt, createdAt: new Date(), updatedAt: new Date(),
};
const attempt: PaymentAttemptEntity = {
  id: "da000000-0000-4000-8000-000000000006", bookingId, adjustmentId: id, method: "online", provider: "stripe",
  providerPaymentId: "pi_existing", amountMinor: 2500, currency: "RON", status: "pending", expiresAt,
  createdAt: new Date(), updatedAt: new Date(), completedAt: null,
  checkoutTokenHash: createHash("sha256").update(token).digest("hex"),
};
const presentation = { kind: "stripe", clientSecret: "existing-secret", publishableKey: "pk_test_Fixture" } as const;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDataSource).mockResolvedValue(source);
  vi.mocked(adjustments.findAdjustment).mockResolvedValue({ ...adjustment });
  vi.mocked(adjustments.adjustmentAttempt).mockResolvedValue({ ...attempt });
  vi.mocked(onlinePaymentAdapter).mockResolvedValue(adapter);
  adapter.resumePayment.mockResolvedValue(presentation);
});

test("valid repeated access retrieves only the registered checkout and preserves its capability", async () => {
  const expected = { kind: "checkout", originalTotal: 5000, newTotal: 7500, currency: "RON", holdExpiresAt: expiresAt.toISOString(),
    checkout: { attemptId: attempt.id, token, presentation } };
  expect(await readAdjustmentPaymentLink(access)).toEqual(expected);
  expect(await readAdjustmentPaymentLink(access)).toEqual(expected);
  expect(onlinePaymentAdapter).toHaveBeenCalledWith("stripe");
  expect(adapter.resumePayment).toHaveBeenCalledTimes(2);
  expect(adapter.resumePayment).toHaveBeenCalledWith({ id: attempt.id, providerPaymentId: "pi_existing" });
  for (const operation of [adapter.createPayment, adapter.readPayment, adapter.cancelPayment, adapter.refundPayment, inTransaction])
    expect(operation).not.toHaveBeenCalled();
  expect(attempt.checkoutTokenHash).toBe(createHash("sha256").update(token).digest("hex"));
});

test.each([undefined, { adjustmentId: "invalid", token }, { adjustmentId: id }, { adjustmentId: id, token: [token] },
  { adjustmentId: id, token: "invalid" }])("invalid route input %j cannot read private facts", async input => {
  expect(await readAdjustmentPaymentLink(input)).toEqual({ kind: "unavailable" });
  expect(getDataSource).not.toHaveBeenCalled();
  expect(onlinePaymentAdapter).not.toHaveBeenCalled();
});

test.each([null, "b".repeat(64)])("invalidated or mismatched capability %s exposes no presentation", async checkoutTokenHash => {
  vi.mocked(adjustments.adjustmentAttempt).mockResolvedValue({ ...attempt, checkoutTokenHash });
  expect(await readAdjustmentPaymentLink(access)).toEqual({ kind: "unavailable" });
  expect(adapter.resumePayment).not.toHaveBeenCalled();
});

test.each([
  { adjustmentId: "da000000-0000-4000-8000-000000000007" },
  { bookingId: "da000000-0000-4000-8000-000000000007" },
  { method: "pay_at_club" as const }, { provider: null }, { provider: "netopia" as const }, { providerPaymentId: null },
])("unavailable or mismatched attempt %j cannot contact a provider", async changed => {
  vi.mocked(adjustments.adjustmentAttempt).mockResolvedValue({ ...attempt, ...changed });
  expect(await readAdjustmentPaymentLink(access)).toEqual({ kind: "unavailable" });
  expect(onlinePaymentAdapter).not.toHaveBeenCalled();
});

test.each(["adjustment", "attempt"])("missing %s returns only a safe unavailable state", async missing => {
  if (missing === "adjustment") vi.mocked(adjustments.findAdjustment).mockResolvedValue(null);
  else vi.mocked(adjustments.adjustmentAttempt).mockResolvedValue(null);
  expect(await readAdjustmentPaymentLink(access)).toEqual({ kind: "unavailable" });
  expect(adapter.resumePayment).not.toHaveBeenCalled();
});

test.each([
  ["pending", "pending"], ["applied", "succeeded"], ["unsuccessful", "failed"], ["cancelled", "cancelled"], ["expired", "expired"],
] as const)("%s/%s presentation preserves the existing polling lifecycle without initiating payment", async (status, paymentStatus) => {
  vi.mocked(adjustments.findAdjustment).mockResolvedValue({ ...adjustment, status });
  vi.mocked(adjustments.adjustmentAttempt).mockResolvedValue({ ...attempt, status: paymentStatus });
  expect(await readAdjustmentPaymentLink(access)).toMatchObject({ kind: "checkout", checkout: { attemptId: attempt.id, token } });
  expect(adapter.createPayment).not.toHaveBeenCalled();
  expect(inTransaction).not.toHaveBeenCalled();
});

test("a past hold deadline is preserved for existing expiry/polling; presentation never extends it", async () => {
  const past = new Date("2020-01-01T00:00:00Z");
  vi.mocked(adjustments.findAdjustment).mockResolvedValue({ ...adjustment, expiresAt: past });
  expect(await readAdjustmentPaymentLink(access)).toMatchObject({ kind: "checkout", holdExpiresAt: past.toISOString() });
  expect(inTransaction).not.toHaveBeenCalled();
});

test.each(["database", "provider"])("unexpected %s failure returns no private facts or exception text", async failure => {
  if (failure === "database") vi.mocked(adjustments.findAdjustment).mockRejectedValue(new Error("private financial payload"));
  else adapter.resumePayment.mockRejectedValue(new Error("secret provider payload"));
  expect(await readAdjustmentPaymentLink(access)).toEqual({ kind: "unavailable" });
  expect(adapter.createPayment).not.toHaveBeenCalled();
});
