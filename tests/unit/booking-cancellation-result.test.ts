import { beforeEach, expect, test, vi } from "vitest";
import { summarizeRefunds } from "@/lib/payments/domain";
import { finishBookingCancellation, type RefundStatus } from "@/lib/payments/refunds";
import { prepareAutomaticRefund } from "@/lib/payments/refund-commands";

vi.mock("@/lib/payments/refund-commands");
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

beforeEach(() => vi.resetAllMocks());

const summaries: { statuses: RefundStatus[]; expected: RefundStatus | undefined }[] = [
  { statuses: [], expected: undefined },
  { statuses: ["succeeded"], expected: "succeeded" },
  { statuses: ["pending"], expected: "pending" },
  { statuses: ["pending_retry"], expected: "pending_retry" },
  { statuses: ["failed"], expected: "failed" },
  { statuses: ["succeeded", "succeeded"], expected: "succeeded" },
  { statuses: ["succeeded", "pending"], expected: "pending" },
  { statuses: ["pending", "succeeded", "pending_retry"], expected: "pending_retry" },
  { statuses: ["pending_retry", "pending", "failed", "succeeded"], expected: "failed" },
];

test.each(summaries)("cancellation uses shared obligation summary $statuses -> $expected", async ({ statuses, expected }) => {
  expect(summarizeRefunds(statuses)).toBe(expected);
  expect(summarizeRefunds([...statuses].reverse())).toBe(expected);
  const refundIds = statuses.map((_, i) => `ce000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  for (const status of statuses) {
    vi.mocked(prepareAutomaticRefund).mockResolvedValueOnce({ outcome: "terminal", status, notice: null });
  }
  expect(await finishBookingCancellation({ outcome: "cancelled", refundIds }))
    .toEqual(expected ? { ok: true, outcome: "cancelled", refundStatus: expected } : { ok: true, outcome: "cancelled" });
  expect(vi.mocked(prepareAutomaticRefund).mock.calls).toEqual(refundIds.map(id => [id]));
});

test("a refund persistence failure leaves cancellation successful and awaiting recovery", async () => {
  vi.mocked(prepareAutomaticRefund).mockRejectedValueOnce(new Error("Database unavailable"));
  expect(await finishBookingCancellation({ outcome: "cancelled", refundIds: ["ce000000-0000-4000-8000-000000000001"] }))
    .toEqual({ ok: true, outcome: "cancelled", refundStatus: "pending_retry" });
});

test.each(["inactive", "unavailable", "started", "notice_required"] as const)("%s outcome never executes refunds", async outcome => {
  expect(await finishBookingCancellation({ outcome }, "Unavailable")).toEqual({ ok: false,
    message: outcome === "started" ? "This booking has started and can no longer be cancelled here."
      : outcome === "notice_required" ? "The cancellation notice period for this booking has expired." : "Unavailable" });
  expect(prepareAutomaticRefund).not.toHaveBeenCalled();
});
