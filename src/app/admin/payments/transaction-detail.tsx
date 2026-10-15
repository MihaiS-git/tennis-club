"use client";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { formatMoney } from "@/lib/pricing/money";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
import { paymentMethodLabels, paymentProviderLabels, adminPaymentHref, parseAdminPaymentQuery, transactionStatusLabel, transactionTimestamp } from "@/lib/payments/admin-query";

const bookingStatusLabels: Record<string, string> = {
  confirmed: "Confirmed", cancelled: "Cancelled", pending_payment: "Awaiting payment", failed: "Failed", expired: "Expired",
};
// Plain-language outcomes; provider codes stay out of the UI. Automatic recovery
// owns every financial transition, so these explain state rather than offer actions.
const refundFailures: Record<string, string> = {
  provider_refund_failed: "Stripe reported that the refund failed.",
  provider_request_rejected: "Stripe declined this refund.",
};
const capturedPaymentProblems: Record<string, string> = {
  expired: "The customer paid after checkout had expired, so the booking was not confirmed.",
  cancelled: "The customer paid after the payment request was cancelled.",
  failed: "The customer paid after the payment request had failed.",
  amount_mismatch: "The amount Stripe received does not match the amount requested.",
  unavailable: "A payment was received but could not be applied to the booking.",
  pending: "A payment was received but has not been applied to the booking.",
};
const tones = {
  success: "bg-success-background text-success", warning: "bg-warning-background text-foreground",
  danger: "bg-danger-background text-danger", neutral: "bg-surface-muted text-muted-foreground",
};

function Badge({ tone, children }: { tone: keyof typeof tones; children: ReactNode }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}
function Fields({ entries }: { entries: [string, ReactNode][] }) {
  return entries.map(([label, value]) => <Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></Fragment>);
}
function Card({ title, label, children }: { title: string; label?: string; children: ReactNode }) {
  return <section aria-label={label ?? title} className="rounded-card border border-border bg-surface p-4 sm:p-5">
    <h3 className="mb-3 font-heading text-base font-semibold text-primary">{title}</h3>{children}
  </section>;
}
const schedule = (value: { date: string; start: number; end: number; timezone: string }, timezone: string) =>
  `${reservationDateLabel(value.date)} · ${minuteToTime(value.start)}–${minuteToTime(value.end)}${value.timezone === timezone ? "" : ` (${value.timezone})`}`;

function statusTone(t: AdminPaymentTransaction): keyof typeof tones {
  if (t.needsAttention || t.transaction_status === "failed") return "danger";
  if (t.transaction_status === "pending" || t.transaction_status === "pending_retry") return "warning";
  return t.transaction_status === "succeeded" ? "success" : "neutral";
}

type Version = { court: string; location: string; date: string; start: number; end: number; timezone: string; total: number; currency: AdminPaymentTransaction["currency"] };

// Previous and new booking for a modification, from the recorded contract context only.
function modification(t: AdminPaymentTransaction): { before: Version; after: Version; applied: boolean } | null {
  const c = t.context;
  const current: Version = { court: c.courtName, location: c.locationName, date: c.bookingDate, start: c.startMinute,
    end: c.endMinute, timezone: c.timezone, total: c.totalAmountMinor, currency: c.currency };
  if (t.previous_context) {
    const p = t.previous_context;
    return { applied: true, after: current, before: { court: p.courtName, location: p.locationName, date: p.bookingDate,
      start: p.startMinute, end: p.endMinute, timezone: p.timezone, total: p.totalAmountMinor, currency: p.currency } };
  }
  if (!t.proposal) return null;
  const p = t.proposal;
  return { applied: p.acceptedRevisionId !== null, before: current, after: { court: p.courtName, location: p.locationName,
    date: p.date, start: p.startMinute, end: p.endMinute, timezone: p.timezone, total: p.totalAmountMinor, currency: p.currency } };
}

export function TransactionDetail({ transaction: t, listHref = "/admin/payments/transactions" }: {
  transaction: AdminPaymentTransaction; listHref?: string;
}) {
  const status = transactionStatusLabel(t);
  const refund = t.refund;
  const isRefund = t.transaction_kind === "refund";
  const captured = t.payment_attempt_id !== null
    && (t.financials?.captures.some((capture) => capture.paymentAttemptId === t.payment_attempt_id) ?? false);
  const change = t.proposal?.kind === "cancellation" || refund?.reason === "booking_cancellation" ? null : modification(t);
  const priceDifference = change ? change.after.total - change.before.total : 0;
  const amountLabel = isRefund ? refund?.status === "succeeded" ? "Refunded" : "Refund amount"
    : change ? t.transaction_status === "succeeded" ? "Additional charge" : "Additional amount"
    : t.transaction_kind === "booking" ? "Booking amount" : "Payment amount";
  const providerReference = isRefund ? refund?.provider_refund_id ?? null : t.provider_payment_id;
  const bookingHref = adminPaymentHref({ ...parseAdminPaymentQuery({}), q: t.booking_id });

  // Attention lists only genuine exceptions: money automation cannot return,
  // recovery stalled beyond Stripe's idempotency window, or captured evidence.
  const refundFailed = refund?.status === "failed";
  const unresolvedEvents = t.reconciliation.filter((event) => event.reconciliation_required);
  const resolvedEvents = t.reconciliation.filter((event) => !event.reconciliation_required && event.resolved_at);
  const attention = refundFailed || t.refundStalled || unresolvedEvents.length > 0;

  const outcome = isRefund ? refund?.status === "succeeded" ? "The refund was confirmed by Stripe."
      : refund?.status === "voided" ? "No money was refunded. The requested booking change was abandoned and the booking kept its original terms."
      : (refund?.status === "pending" || refund?.status === "pending_retry") && !t.refundStalled
        ? "The refund is being confirmed with Stripe automatically. No action is needed." : null
    : t.transaction_status === "succeeded" ? null
    : t.transaction_status === "due" ? "The customer pays at the club."
    : t.transaction_status === "pending" ? "Waiting for the customer to complete payment. The outcome is checked with Stripe automatically."
    : captured ? null
    : t.transaction_status === "failed" ? "The payment did not go through. No money was taken."
    : t.transaction_status === "expired" ? "The payment window expired before the customer paid. No money was taken."
    : t.transaction_status === "cancelled" ? "The payment request was cancelled. No money was taken." : null;
  const cancellation = t.proposal?.kind === "cancellation" ? t.proposal.status === "pending"
      ? "Cancellation requested. The booking stays confirmed until Stripe confirms the refund."
      : t.proposal.status === "applied" ? "The booking was cancelled after the refund was confirmed."
      : "The cancellation was not completed because the refund failed. The booking was kept and the customer was notified."
    : null;

  return <section aria-label="Transaction details" className="min-w-0 w-full space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Link href={listHref} className="text-sm text-primary underline">Back to transactions</Link>
        <h2 className="mt-1 font-heading text-2xl font-semibold text-primary">{t.operation_label}</h2>
        <p className="mt-1 text-sm text-muted-foreground"><time dateTime={t.created_at}>
          {transactionTimestamp(t.created_at, t.location_timezone)}</time></p>
        <p className="mt-1 text-xs text-muted-foreground">Times in {t.location_timezone} unless indicated otherwise.</p>
      </div>
      <div className="flex w-full flex-col items-start gap-1 text-left sm:w-auto sm:items-end sm:text-right">
        <span className="text-sm text-muted-foreground">{amountLabel}</span>
        <strong className="text-2xl tabular-nums text-foreground">{isRefund ? "−" : "+"}{formatMoney(t.amount_minor, t.currency)}</strong>
        <Badge tone={statusTone(t)}>{status}</Badge>
      </div>
    </div>
    {outcome && <p className="text-sm text-muted-foreground">{outcome}</p>}
    {cancellation && <p className="text-sm text-muted-foreground">{cancellation}</p>}

    {attention && <section aria-label="Needs attention" className="rounded-card border border-danger bg-danger-background/40 p-4 text-sm">
      <h3 className="mb-2 font-heading text-base font-semibold text-danger">Needs attention</h3>
      <ul className="space-y-3">
        {refund && refundFailed && <li>
          {refund.last_error && Object.hasOwn(refundFailures, refund.last_error) ? refundFailures[refund.last_error] : "This refund could not be completed."}
          {" "}The customer has not received this money and has been notified. Stripe will not be asked again automatically;
          arrange the repayment with the customer directly.
        </li>}
        {refund && t.refundStalled && <li>
          Automatic recovery has not been able to confirm this refund with Stripe for over a day. Check it in the Stripe
          Dashboard before contacting the customer. Do not issue another refund for it.
        </li>}
        {unresolvedEvents.map((event) => <li key={event.event_id}>
          {Object.hasOwn(capturedPaymentProblems, event.settlement_result) ? capturedPaymentProblems[event.settlement_result] : "A payment was received that needs review."}
          {event.auto_refund ? " The court was not reclaimed; the payment is being returned automatically." : " Review this payment in Stripe."}
        </li>)}
      </ul>
    </section>}

    <div className={`grid gap-4${change ? " lg:grid-cols-2" : " max-w-3xl"}`}>
      <Card title="Customer and transaction">
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] sm:grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <Fields entries={[
            ["Customer", <span key="c" className="block"><span className="block font-medium">{t.customer_name}</span>
              <span className="block text-muted-foreground">{t.customer_email} · {t.customer_phone}</span></span>],
            ["Payment", `${t.method ? paymentMethodLabels[t.method] : "Unknown"}${t.provider ? ` · ${paymentProviderLabels[t.provider]}` : ""}`],
            ...resolvedEvents.slice(-1).map((event) => ["Reconciled", transactionTimestamp(event.resolved_at ?? event.received_at, t.location_timezone)] satisfies [string, ReactNode]),
          ]} />
        </dl>
        {!change && <div className="mt-4 border-t border-border pt-4">
          <h4 className="mb-2 text-sm font-semibold">Historical booking context</h4>
          <p className="mb-3 text-xs text-muted-foreground">Recorded schedule and price associated with this transaction.</p>
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] sm:grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <Fields entries={[
              ["Location", `${t.context.locationName} · ${t.context.courtName}`],
              ["Schedule", schedule({ date: t.context.bookingDate, start: t.context.startMinute, end: t.context.endMinute, timezone: t.context.timezone }, t.location_timezone)],
              ["Booking price", formatMoney(t.context.totalAmountMinor, t.context.currency)],
            ]} />
          </dl>
        </div>}
        <dl className="mt-4 grid grid-cols-[5.5rem_minmax(0,1fr)] sm:grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
          <Fields entries={[["Current booking status", bookingStatusLabels[t.current_booking.status] ?? t.current_booking.status]]} />
        </dl>
        <Link href={bookingHref} className="mt-4 inline-block text-sm text-primary underline">All transactions for this booking</Link>
        {providerReference && <p className="mt-4 break-all text-xs text-muted-foreground">
          {t.provider ? paymentProviderLabels[t.provider] : "Provider"} reference: <span className="font-mono">{providerReference}</span>
        </p>}
      </Card>

      {change && <Card title={change.applied ? "Booking modification" : "Requested modification (not applied)"} label="Modification">
        <p className="mb-3 text-xs text-muted-foreground">Historical booking context recorded for this transaction.</p>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] sm:grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <Fields entries={[
            ["Previous", <span key="p" className="block"><span className="block">{change.before.location} · {change.before.court}</span>
              <span className="block">{schedule(change.before, t.location_timezone)}</span>
              <span className="block tabular-nums">{formatMoney(change.before.total, change.before.currency)}</span></span>],
            [change.applied ? "New" : "Requested", <span key="n" className="block"><span className="block">{change.after.location} · {change.after.court}</span>
              <span className="block">{schedule(change.after, t.location_timezone)}</span>
              <span className="block tabular-nums">{formatMoney(change.after.total, change.after.currency)}</span></span>],
            ["Price difference", <span key="d" className="tabular-nums">{priceDifference < 0 ? "−" : priceDifference > 0 ? "+" : ""}{formatMoney(Math.abs(priceDifference), change.after.currency)}</span>],
          ]} />
        </dl>
      </Card>}
    </div>
  </section>;
}
