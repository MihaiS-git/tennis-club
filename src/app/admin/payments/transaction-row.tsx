"use client";

import { toast } from "sonner";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  recoverAdjustmentPaymentAction,
  retryPaymentRefundAction,
  resolvePaymentReconciliationAction,
} from "./reconciliation-actions";
import { Fragment, useEffect, useRef, useState } from "react";
import { DetailSection } from "@/components/dialog-layout";
import { Button } from "@/components/button";
import { formatMoney } from "@/lib/pricing/money";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
import { refundReasonLabels } from "@/lib/payments/financial-history-context";
import {
  paymentMethodLabels,
  paymentProviderLabels,
  adminTransactionHref,
  transactionStatusLabel,
} from "@/lib/payments/admin-query";

const refundLabels = {
  pending: "Pending",
  pending_retry: "Pending retry",
  succeeded: "Completed",
  failed: "Failed",
};
const executionStatusLabels = {
  ready: "Ready — not dispatched", pending: "Pending — outcome unconfirmed", uncertain: "Uncertain — outcome unconfirmed",
  succeeded: "Verified success", failed: "Verified failure", rejected: "Definitively rejected",
};
const bookingStatusLabels: Record<string, string> = {
  confirmed: "Confirmed", cancelled: "Cancelled", pending_payment: "Pending payment", failed: "Failed", expired: "Expired",
};
const date = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
const refundErrors: Record<string, string> = {
  provider_request_incomplete:
    "The refund request did not complete or its result could not be confirmed.",
  provider_refund_failed: "The provider reported that the refund failed.",
  provider_request_rejected: "The provider definitively rejected this refund request.",
  uncertain: "The refund request may have been accepted. Its outcome is not yet confirmed.",
  lookup_failed: "The provider refund could not be checked. Its outcome remains unconfirmed.",
  not_found: "The previous refund request could not be recovered. Its outcome remains uncertain.",
  evidence_mismatch: "The provider response did not match the stored refund request. Review is required.",
};
const settlementReasons: Record<string, string> = {
  expired:
    "Payment arrived after checkout expired; the booking was not confirmed.",
  amount_mismatch:
    "The received payment amount or currency did not match the persisted payment snapshot.",
  unavailable: "Payment could not be applied to the booking lifecycle.",
  pending: "Successful payment remains unresolved in the payment lifecycle.",
  cancelled: "Successful payment was recorded for a cancelled attempt.",
  failed: "Successful payment was recorded for a failed attempt.",
};
const captureDiscrepancyLabels = {
  provider: "provider",
  provider_payment_id: "provider payment identity",
  amount: "amount",
  currency: "currency",
};
function Fields({ entries }: { entries: [string, string][] }) {
  return entries.map(([label, value]) => (
    <Fragment key={label}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </Fragment>
  ));
}

export function TransactionRow({
  transaction, detail = false, listHref = "/admin/payments/transactions",
}: {
  transaction: AdminPaymentTransaction;
  detail?: boolean;
  listHref?: string;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState({
    source: transaction,
    current: transaction,
  });
  if (snapshot.source !== transaction)
    setSnapshot({ source: transaction, current: transaction });
  const t = snapshot.source === transaction ? snapshot.current : transaction;
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const active = useRef(true);
  const notificationRef = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; if (notificationRef.current !== undefined) toast.dismiss(notificationRef.current); };
  }, []);
  async function act(kind: "retry" | "reconcile" | "recover", id: string) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);

    try {
      const result = await (kind === "retry"
        ? retryPaymentRefundAction(id)
        : kind === "recover" ? recoverAdjustmentPaymentAction(id) : resolvePaymentReconciliationAction(id));
      if (!active.current) return;
      if (!result.ok) notificationRef.current = toast.error(result.message);
      else {
        if (result.transaction.transaction_id === transaction.transaction_id && result.transaction.transaction_kind === transaction.transaction_kind)
          setSnapshot({ source: transaction, current: result.transaction });
        notificationRef.current = toast.success(result.message);
      }
      router.refresh();
    } catch {
      if (!active.current) return;
      notificationRef.current = toast.error("Unable to complete this payment action. Refresh and try again.");
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  }
  const payment = transactionStatusLabel(t);
  const method = t.method ? paymentMethodLabels[t.method] : "Unknown";
  const provider = t.provider ? paymentProviderLabels[t.provider] : "—";
  const refund = t.refund;
  const href = adminTransactionHref(t.transaction_kind, t.transaction_id, listHref.split("?")[1]);
  if (!detail) return (
      <tr
        tabIndex={0}
        aria-label={`${t.operation_label} ${t.transaction_id}, booking ${t.booking_id}`}
        onClick={event => { if (!(event.target instanceof Element && event.target.closest("a"))) router.push(href); }}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault(); router.push(href);
          }
        }}
        className="cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus [&_td]:px-3 [&_td]:py-3"
      >
        <td className="whitespace-nowrap">
          <time dateTime={t.created_at}>{date(t.created_at)}</time>
        </td>
        <td>
          <span className="block font-medium">{t.customer_name}</span>
          <span className="block text-xs text-muted-foreground">
            {t.customer_email}
          </span>
        </td>
        <td className="font-mono text-xs">#{t.booking_id.slice(0, 8)}</td>
        <td><Link href={href} className="text-primary underline">{t.operation_label}</Link>
          {t.proposal && !t.proposal.acceptedRevisionId && <span className="block text-xs text-muted-foreground">
            Proposed modification · {t.proposal.status === "pending" ? "Pending" : "Not applied"}
          </span>}
          <span className="block font-mono text-xs">{t.transaction_id}</span></td>
        <td className="whitespace-nowrap">
          {formatMoney(t.amount_minor, t.currency)}
        </td>
        <td>{method}</td>
        <td>{provider}</td>
        <td>{payment}</td>

        <td>
          {t.needsAttention ? (
            <span className="inline-flex whitespace-nowrap rounded-control bg-danger-background px-2 py-1 text-xs font-semibold text-danger">
              Needs attention
            </span>
          ) : (
            "—"
          )}
        </td>
      </tr>
  );
  return <section aria-label="Transaction details" className="rounded-card border border-border bg-surface p-5">
    <h2 className="text-xl font-semibold">{t.operation_label}</h2>
    {pending && <p role="status" className="mt-2 text-sm">Processing financial operation…</p>}
    <Link href={listHref} className="my-3 inline-block text-primary underline">Back to transactions</Link>
    <DetailSection title="Transaction">
      <Fields
        entries={[
          ["Transaction ID", t.transaction_id],
          ["Payment attempt ID", t.payment_attempt_id ?? "—"],
          ["Adjustment ID", t.adjustment_id ?? "—"],
          ["Amount", formatMoney(t.amount_minor, t.currency)],
          ["Currency", t.currency],
          ["Method", method],
          ["Provider", provider],
          ["Status", payment],
          ["Provider payment ID", t.provider_payment_id ?? "—"],
          ["Created", `${date(t.created_at)} UTC`],
          ["Last updated", `${date(t.updated_at)} UTC`],
        ]}
      />
    </DetailSection>
    <DetailSection title="Transaction context">
      <Fields
        entries={[
          ["Booking ID", t.booking_id],
          ["Customer name", t.customer_name],
          ["Customer email", t.customer_email],
          ["Customer phone", t.customer_phone],
          ["Context revision", t.context.revisionId],
          ["Contract state", t.context.bookingState === "pending_payment" ? "Original pending checkout request"
            : t.context.bookingState === "cancelled" ? "Accepted cancellation" : "Accepted booking"],
          ["Contract total", formatMoney(t.booking_total_minor, t.context.currency)],
          ...(t.context.confirmationRevisionId ? [["Confirmation revision", t.context.confirmationRevisionId] satisfies [string, string]] : []),
          ["Reservation ID", t.reservation_id],
          ["Location", t.location_name],
          ["Court", t.court_name],
          [
            "Schedule",
            `${reservationDateLabel(t.booking_date)} · ${minuteToTime(t.starts_at_minute)}–${minuteToTime(t.ends_at_minute)} (${t.location_timezone})`,
          ],
        ]}
      />
    </DetailSection>
    {t.previous_context && <DetailSection title="Previous accepted contract">
      <Fields entries={[
        ["Location", t.previous_context.locationName], ["Court", t.previous_context.courtName],
        ["Schedule", `${reservationDateLabel(t.previous_context.bookingDate)} · ${minuteToTime(t.previous_context.startMinute)}–${minuteToTime(t.previous_context.endMinute)} (${t.previous_context.timezone})`],
        ["Contract total", formatMoney(t.previous_context.totalAmountMinor, t.previous_context.currency)],
      ]} />
    </DetailSection>}
    {t.proposal && <DetailSection title="Modification proposal">
      <Fields entries={[
        ["Proposal status", t.proposal.acceptedRevisionId ? "Applied" : t.proposal.status === "pending" ? "Proposed — Pending" : `Proposed — Not applied (${t.proposal.status})`],
        ["Proposed location", t.proposal.locationName], ["Proposed court", t.proposal.courtName],
        ["Proposed schedule", `${reservationDateLabel(t.proposal.date)} · ${minuteToTime(t.proposal.startMinute)}–${minuteToTime(t.proposal.endMinute)} (${t.proposal.timezone})`],
        ["Proposed total", formatMoney(t.proposal.totalAmountMinor, t.proposal.currency)],
      ]} />
    </DetailSection>}
    {refund && <section className="mt-4">
      <h3 className="mb-2 text-sm font-semibold text-primary">Refund execution history</h3>
      <p className="text-sm text-muted-foreground">Provider operations for this one refund obligation. Requested amounts are not additional obligations or verified returns.</p>
      {refund.executions.length === 0 && <p className="text-sm">No executions recorded.</p>}
      {refund.executions.map(execution => <div key={execution.id} className="mt-3 rounded-lg border border-border p-4">
        <h3 className="mb-3 font-medium">Execution {execution.executionNumber}</h3>
        <h4 className="mb-2 text-sm font-medium">Stored request and verified provider outcome</h4>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm break-words">
          <Fields entries={[
            ["Execution ID", execution.id], ["Provider", paymentProviderLabels[execution.provider]],
            ["Requested amount", formatMoney(execution.amountMinor, execution.currency)],
            ["Provider payment ID", execution.providerPaymentId], ["Provider refund ID", execution.providerRefundId ?? "—"],
            ["Created", `${date(execution.createdAt)} UTC`],
            ["Dispatch initiated", execution.dispatchInitiatedAt ? `${date(execution.dispatchInitiatedAt)} UTC` : "Not established"],
            ["First uncertain outcome", execution.firstUncertainAt ? `${date(execution.firstUncertainAt)} UTC` : "—"],
            ["Verified outcome", execution.terminalResult ? executionStatusLabels[execution.terminalResult] : "No confirmed outcome"],
            ["Verified completion", execution.completedAt ? `${date(execution.completedAt)} UTC` : "—"],
          ]} />
        </dl>
        <h4 className="mt-4 mb-2 text-sm font-medium">Current operational status</h4>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm break-words">
          <Fields entries={[
            ["Processing status", executionStatusLabels[execution.status]],
            ["Unresolved", execution.unresolved ? "Yes" : "No"],
            ["Last checked", execution.lastCheckedAt ? `${date(execution.lastCheckedAt)} UTC` : "—"],
            ["Operational error", execution.lastError ? Object.hasOwn(refundErrors, execution.lastError)
              ? refundErrors[execution.lastError] : "A refund processing error was recorded." : "—"],
          ]} />
        </dl>
      </div>)}
    </section>}
    {refund && (
      <DetailSection title="Refund">
        <Fields
          entries={[
            ["Refund ID", refund.id],
            ["Reason", refundReasonLabels[refund.reason]],
            ["Captured payment amount", refund.captured_amount_minor ? formatMoney(refund.captured_amount_minor, refund.currency) : "—"],
            [
              "Amount",
              formatMoney(refund.amount_minor, refund.currency),
            ],
            ["Status", refundLabels[refund.status]],
            ["Provider refund ID", refund.provider_refund_id ?? "—"],
            [
              "Requested by",
              refund.requested_by_name ??
                refund.requested_by_user_id ??
                "—",
            ],
            ["Created", `${date(refund.created_at)} UTC`],
            ["Last updated", `${date(refund.updated_at)} UTC`],
            ...(refund.last_error
              ? [
                  [
                    "Error",
                    Object.hasOwn(refundErrors, refund.last_error)
                      ? refundErrors[refund.last_error]
                      : "A refund processing error was recorded.",
                  ] satisfies [string, string],
                ]
              : []),
          ]}
        />
        {t.canRetryRefund && (
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={pending}
              aria-busy={pending}
              onClick={() => void act("retry", refund.id)}
            >
              Retry refund
            </Button>
          </div>
        )}
      </DetailSection>
    )}
    {t.financials && <section aria-label="Financial history" className="mt-4 space-y-2 text-sm">
      <h3 className="font-semibold">Current booking summary</h3>
      <p>Current booking status: {bookingStatusLabels[t.current_booking.status] ?? t.current_booking.status}</p>
      <p>Booking total: {formatMoney(t.current_booking.totalAmountMinor, t.current_booking.currency)}</p>
      <p>Outstanding: {formatMoney(t.financials.outstanding, t.current_booking.currency)}</p>
      <h4 className="font-medium">Verified money movements by currency</h4>
      {t.financials.totals.length === 0 && <p>No verified money movements.</p>}
      {t.financials.totals.map(total => <p key={total.currency}>
        {total.currency}: Captured {formatMoney(total.captured, total.currency)} · Refunded {formatMoney(total.refunded, total.currency)} · Net {formatMoney(total.netPaid, total.currency)}
        {total.uncompletedRefundObligations > 0 && <> · Pending or failed refund obligations {formatMoney(total.uncompletedRefundObligations, total.currency)}</>}
      </p>)}
      <h4 className="font-medium">Verified capture receipts</h4>
      {t.financials.captures.length === 0 && <p>No verified capture receipts.</p>}
      {t.financials.captures.map(capture => <div key={capture.id} className="rounded-lg border border-border p-3">
        <p>Capture {capture.providerCaptureId}: {formatMoney(capture.amount, capture.currency)} · payment {capture.providerPaymentId}</p>
        {capture.discrepancies.length > 0 ? <p className="text-danger">
          Discrepancy: {capture.discrepancies.map(discrepancy => captureDiscrepancyLabels[discrepancy]).join(", ")}.
          {capture.expectedAmount !== null && capture.expectedCurrency !== null
            ? ` Requested ${formatMoney(capture.expectedAmount, capture.expectedCurrency)}.` : " Payment request unavailable."}
        </p> : <p>Matches the stored payment request.</p>}
        {capture.attemptStatus && capture.attemptStatus !== "succeeded" && <p>
          Capture was received after the payment attempt became {capture.attemptStatus}.
        </p>}
      </div>)}
      {t.financials.payments.map(p => <div key={p.id}>
        <p><Link href={adminTransactionHref("payment", p.id)} className="text-primary underline">Payment request {p.id}</Link> {formatMoney(p.amount, p.currency)} · {p.status} · {p.reference ?? "No provider reference"}</p>
        {p.adjustmentId && p.status !== "succeeded" && <Button type="button" size="small" variant="secondary"
          disabled={pending} onClick={() => { if (p.adjustmentId) void act("recover",p.adjustmentId); }}>Check modification payment</Button>}
      </div>)}
      {t.financials.refunds.map(r => <div key={r.id}>
        <p><Link href={adminTransactionHref("refund", r.id)} className="text-primary underline">Refund obligation {r.id}</Link> {formatMoney(r.amount, r.currency)} · {r.status}{r.verified ? " · verified successful execution" : " · not counted as refunded"} · {r.reference ?? "No verified provider refund reference"}</p>
        {["pending", "pending_retry", "failed"].includes(r.status) && <Button type="button" size="small" variant="secondary"
          disabled={pending} onClick={() => void act("retry", r.id)}>Retry refund {formatMoney(r.amount, r.currency)}</Button>}
      </div>)}
    </section>}
    {(t.needsAttention ||
      t.reconciliation.some((event) => event.resolved_at)) && (
      <section className="mt-4 text-sm" aria-label="Reconciliation">
        <h3 className="mb-2 font-semibold text-primary">
          Reconciliation
        </h3>
        {refund?.status === "pending_retry" && (
          <p>
            The refund is awaiting retry or confirmation of its result.
          </p>
        )}
        {refund?.status === "failed" && (
          <p>The refund failed and needs review.</p>
        )}
        {t.reconciliation.map((event, index) => (
          <div key={index} className="mt-3">
            <p>
              {Object.hasOwn(settlementReasons, event.settlement_result)
                ? `${settlementReasons[event.settlement_result]} Recorded settlement: ${event.settlement_result}.`
                : "A payment reconciliation requirement was recorded."}{" "}
              ({date(event.received_at)} UTC)
            </p>
            {event.resolved_at && (
              <p className="mt-2 text-success">
                Resolved · {date(event.resolved_at)} UTC
              </p>
            )}
            {event.can_refund && (
              <>
                <p className="mt-2">
                  Payment succeeded after the reservation hold was no
                  longer valid. The court was not reclaimed.
                </p>
                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={pending}
                    aria-busy={pending}
                    onClick={() =>
                      void act("reconcile", event.event_id)
                    }
                  >
                    Refund captured payment
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
      </section>
    )}
  </section>;
}
