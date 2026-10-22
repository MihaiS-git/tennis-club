import type { PaymentProvider } from "./domain";

type PaymentOperation = { id: string; provider: PaymentProvider | null; createdAt: Date;
  status: "pending" | "succeeded" | "failed" | "cancelled" | "expired" | "due" };
type RefundOperation = { id: string; provider: PaymentProvider; createdAt: Date;
  status: "pending" | "pending_retry" | "succeeded" | "failed" | "voided" };

export type LatestFinancialStatus = { operation: "payment"; status: "pending" | "due" | "succeeded" | "failed"; provider: PaymentProvider | null }
  | { operation: "refund"; status: "pending" | "succeeded" | "failed"; provider: PaymentProvider };

// The booking's most recent relevant payment or refund, by persisted creation time with ID as
// tie-breaker. Abandoned operations (cancelled/expired checkouts, voided refunds) never moved
// money and do not replace the current status. Full history stays on the transaction pages.
export function latestFinancialStatus(payments: readonly PaymentOperation[], refunds: readonly RefundOperation[]): LatestFinancialStatus | null {
  const candidates: (LatestFinancialStatus & { id: string; createdAt: Date })[] = [];
  for (const payment of payments) {
    if (payment.status === "cancelled" || payment.status === "expired") continue;
    candidates.push({ operation: "payment", status: payment.status, provider: payment.provider, id: payment.id, createdAt: payment.createdAt });
  }
  for (const refund of refunds) {
    if (refund.status === "voided") continue;
    candidates.push({ operation: "refund", status: refund.status === "pending_retry" ? "pending" : refund.status,
      provider: refund.provider, id: refund.id, createdAt: refund.createdAt });
  }
  const latest = candidates.reduce<(typeof candidates)[number] | null>((current, candidate) => !current
    || candidate.createdAt.getTime() > current.createdAt.getTime()
    || candidate.createdAt.getTime() === current.createdAt.getTime() && candidate.id > current.id ? candidate : current, null);
  if (!latest) return null;
  return latest.operation === "payment" ? { operation: "payment", status: latest.status, provider: latest.provider }
    : { operation: "refund", status: latest.status, provider: latest.provider };
}
