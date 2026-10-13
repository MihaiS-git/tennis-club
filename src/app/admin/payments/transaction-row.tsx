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
    <DetailSection title="Booking">
      <Fields
        entries={[
          ["Booking ID", t.booking_id],
          ["Customer name", t.customer_name],
          ["Customer email", t.customer_email],
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
    {refund && (
      <DetailSection title="Refund">
        <Fields
          entries={[
            ["Refund ID", refund.id],
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
        {refund.provider_history?.map(reference => <p key={reference.provider_refund_id} className="mt-2 text-sm">
          Previous provider refund: {reference.provider_refund_id} · {reference.status} · {date(reference.recorded_at)} UTC
        </p>)}
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
      <h3 className="font-semibold">Financial history</h3>
      <p>Booking total: {formatMoney(t.booking_total_minor ?? t.amount_minor, t.currency)}</p>
      <p>Pending or failed refund obligations: {formatMoney(t.financials.refundObligations - t.financials.refunded, t.currency)}</p>
      <p>Collected: {formatMoney(t.financials.captured, t.currency)} · Refunded: {formatMoney(t.financials.refunded, t.currency)}</p>
      <p>Net paid: {formatMoney(t.financials.netPaid, t.currency)} · Outstanding: {formatMoney(t.financials.outstanding, t.currency)}</p>
      {t.financials.payments.map(p => <div key={p.id}>
        <p><Link href={adminTransactionHref("payment", p.id)} className="text-primary underline">Payment {p.id}</Link> {formatMoney(p.amount, t.currency)} · {p.status} · {p.reference ?? "No provider reference"}</p>
        {p.adjustmentId && p.status !== "succeeded" && <Button type="button" size="small" variant="secondary"
          disabled={pending} onClick={() => { if (p.adjustmentId) void act("recover",p.adjustmentId); }}>Check modification payment</Button>}
      </div>)}
      {t.financials.refunds.map(r => <div key={r.id}>
        <p><Link href={adminTransactionHref("refund", r.id)} className="text-primary underline">Refund {r.id}</Link> {formatMoney(r.amount, t.currency)} · {r.status} · {r.reference ?? "Awaiting provider reference"}</p>
        {["pending", "pending_retry", "failed"].includes(r.status) && <Button type="button" size="small" variant="secondary"
          disabled={pending} onClick={() => void act("retry", r.id)}>Retry refund {formatMoney(r.amount, t.currency)}</Button>}
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
