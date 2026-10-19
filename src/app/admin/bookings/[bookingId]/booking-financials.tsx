import Link from "next/link";
import { Pagination } from "@/components/pagination";
import { StatusBadge } from "@/components/status-badge";
import type { AdminBookingRecords } from "@/lib/bookings/admin-details";
import type { AdminBookingFinancialSummary } from "@/lib/bookings/admin-history";
import { paymentMethodLabels, paymentProviderLabels, transactionStatusLabel, transactionStatusTone,
  transactionTimestamp } from "@/lib/payments/admin-query";
import { formatMoney } from "@/lib/pricing/money";

function Amount({ label, value, hint, emphasis = false }: { label: string; value: string; hint?: string; emphasis?: boolean }) {
  return <div className="min-w-0">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className={`tabular-nums ${emphasis ? "font-semibold text-primary" : "font-medium"}`}>{value}</dd>
    {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
  </div>;
}

// Amounts come from the shared Admin reporting model: captures and verified refunds only.
export function FinancialSummary({ summary }: { summary: AdminBookingFinancialSummary }) {
  const money = (amount: number) => formatMoney(amount, summary.currency);
  return <section aria-labelledby="financial-summary" className="rounded-card border border-border bg-surface p-5">
    <h2 id="financial-summary" className="font-heading text-base font-semibold text-primary">Financial summary</h2>
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
      <Amount label="Current booking total" value={money(summary.total)} emphasis />
      <Amount label="Paid" value={money(summary.paid)} />
      <Amount label="Refunded" value={money(summary.refunded)} />
      <Amount label="Net collected" value={money(summary.net)} />
      {summary.pendingPayments > 0 && <Amount label="Pending payments" value={money(summary.pendingPayments)} hint="Not yet collected" />}
      {summary.pendingRefunds > 0 && <Amount label="Pending refunds" value={money(summary.pendingRefunds)} hint="Not yet confirmed" />}
      {summary.failedRefunds > 0 && <Amount label="Failed refunds" value={money(summary.failedRefunds)} hint="No money was returned" />}
      {summary.activeBooking && summary.outstanding > 0 && <Amount label="Outstanding" value={money(summary.outstanding)} />}
      {summary.dueAtClub > 0 && <Amount label="Due at club" value={money(summary.dueAtClub)} hint="Collected at the club" />}
    </dl>
    {summary.unrecordedAtClub > 0 && <p className="mt-3 text-xs text-muted-foreground">
      {money(summary.unrecordedAtClub)} was payable at the club. Club payments are not recorded online, so this amount is not counted as paid.
    </p>}
    {summary.otherCurrencies.map((total) => <p key={total.currency} className="mt-3 text-xs text-muted-foreground">
      Also recorded in {total.currency}: paid {formatMoney(total.captured, total.currency)}, refunded {formatMoney(total.refunded, total.currency)}.
    </p>)}
  </section>;
}

// Each operation links to its existing Admin Transaction Details page by full identity,
// carrying this Booking Details view so the booking link there returns here.
// One server-side page at a time; the summary above always covers every operation.
export function FinancialHistory({ operations, timezone, pageHref, transactionHref }: { operations: AdminBookingRecords["operations"];
  timezone: string; pageHref(page: number): string; transactionHref(kind: "payment" | "refund" | "booking", id: string): string }) {
  return <section aria-labelledby="financial-history" className="rounded-card border border-border bg-surface p-5">
    <h2 id="financial-history" className="font-heading text-base font-semibold text-primary">Financial history</h2>
    {operations.rows.length ? <>
      <p className="mt-1 text-xs text-muted-foreground">Payments and refunds in recorded order · Times in {timezone}
        {operations.totalPages > 1 && <> · {operations.total} operations</>}</p>
      <div className="mt-3 overflow-x-auto">
        <table aria-label="Financial history" className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border text-xs font-semibold text-muted-foreground">
            <tr className="[&_th]:px-3 [&_th]:py-2"><th scope="col">Date</th><th scope="col">Operation</th><th scope="col">Method</th>
              <th scope="col" className="text-right">Amount</th><th scope="col">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-border">{operations.rows.map((t) => {
            const refund = t.transaction_kind === "refund";
            return <tr key={`${t.transaction_kind}/${t.transaction_id}`} className={`[&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top ${t.needsAttention ? "bg-danger-background/40" : ""}`}>
              <td className="whitespace-nowrap"><time dateTime={t.created_at}>{transactionTimestamp(t.created_at, timezone)}</time></td>
              <td><Link href={transactionHref(t.transaction_kind, t.transaction_id)} className="text-primary underline">{t.operation_label}</Link>
                {t.proposal && !t.proposal.acceptedRevisionId && <span className="block text-xs text-muted-foreground">
                  {t.proposal.kind === "cancellation" ? "Cancellation request" : "Proposed modification"} · {t.proposal.status === "pending" ? "Pending" : "Not applied"}
                </span>}
              </td>
              <td className="whitespace-nowrap">{t.method ? paymentMethodLabels[t.method] : "Unknown"}
                {t.provider && <span className="block text-xs text-muted-foreground">{paymentProviderLabels[t.provider]}</span>}</td>
              <td className={`whitespace-nowrap text-right font-semibold tabular-nums ${refund ? "text-accent" : ""}`}>
                {refund ? "−" : "+"}{formatMoney(t.amount_minor, t.currency)}</td>
              <td><span className="flex flex-col items-start gap-1">
                <StatusBadge tone={transactionStatusTone(t)}>{transactionStatusLabel(t)}</StatusBadge>
                {t.needsAttention && <span className="text-xs font-semibold text-danger">Needs attention</span>}
              </span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {operations.totalPages > 1 && <div className="mt-4"><Pagination currentPage={operations.page} totalPages={operations.totalPages}
        buildHref={pageHref} ariaLabel="Financial history pages" /></div>}
    </> : <p className="mt-2 text-sm text-muted-foreground">No payments or refunds were recorded for this booking.</p>}
  </section>;
}
