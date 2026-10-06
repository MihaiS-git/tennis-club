"use client";

import { useRouter } from "next/navigation";
import {
  retryPaymentRefundAction,
  resolvePaymentReconciliationAction,
} from "./reconciliation-actions";
import { Fragment, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "@/components/modal-dialog";
import {
  DialogHeader,
  DialogFooter,
  DetailSection,
} from "@/components/dialog-layout";
import { Button } from "@/components/button";
import { formatMoney } from "@/lib/pricing/money";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
import {
  paymentMethodLabels,
  paymentProviderLabels,
  paymentStatusLabels,
} from "@/lib/payments/admin-query";

const refundLabels = {
  pending: "Pending",
  pending_retry: "Pending retry",
  succeeded: "Refunded",
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
  transaction,
}: {
  transaction: AdminPaymentTransaction;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState({
    source: transaction,
    current: transaction,
  });
  if (snapshot.source !== transaction)
    setSnapshot({ source: transaction, current: transaction });
  const t = snapshot.source === transaction ? snapshot.current : transaction;
  const [pending, setPending] = useState(false),
    [feedback, setFeedback] = useState(""),
    [actionError, setActionError] = useState("");
  const pendingRef = useRef(false);
  async function act(kind: "retry" | "reconcile", id: string) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFeedback("");
    setActionError("");
    try {
      const result = await (kind === "retry"
        ? retryPaymentRefundAction(id)
        : resolvePaymentReconciliationAction(id));
      if (!result.ok) setActionError(result.message);
      else {
        setSnapshot({ source: transaction, current: result.transaction });
        setFeedback(result.message);
      }
      router.refresh();
    } catch {
      setActionError(
        "Unable to complete this payment action. Refresh and try again.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  const [open, setOpen] = useState(false);
  const titleId = useId(),
    dialogRef = useRef<HTMLDialogElement>(null),
    rowRef = useRef<HTMLTableRowElement>(null);
  const payment = t.payment_status
    ? paymentStatusLabels[t.payment_status]
    : "Unknown";
  const method = t.method ? paymentMethodLabels[t.method] : "Unknown";
  const provider = t.provider ? paymentProviderLabels[t.provider] : "—";
  const refund = t.refund;
  function close() {
    setOpen(false);
    rowRef.current?.focus();
  }
  return (
    <>
      <tr
        ref={rowRef}
        tabIndex={0}
        aria-label={`Payment details for ${t.customer_name}, booking ${t.booking_id}`}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
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
        <td className="whitespace-nowrap">
          {formatMoney(t.amount_minor, t.currency)}
        </td>
        <td>{method}</td>
        <td>{provider}</td>
        <td>{payment}</td>
        <td>{refund ? refundLabels[refund.status] : "—"}</td>
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
      {open &&
        createPortal(
          <ModalDialog
            ref={dialogRef}
            active
            aria-labelledby={titleId}
            onClose={close}
            onCancel={(event) => {
              if (pendingRef.current) event.preventDefault();
            }}
            className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-xl rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50"
          >
            <DialogHeader
              titleId={titleId}
              title="Payment details"
              disabled={pending}
              onClose={() => dialogRef.current?.close()}
            />
            <DetailSection title="Payment">
              <Fields
                entries={[
                  ["Amount", formatMoney(t.amount_minor, t.currency)],
                  ["Currency", t.currency],
                  ["Method", method],
                  ["Provider", provider],
                  ["Payment status", payment],
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
                  <p>The full refund failed and needs review.</p>
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
            <p
              role={actionError ? "alert" : feedback ? "status" : undefined}
              className={`mt-3 min-h-5 text-sm ${actionError ? "text-danger" : "text-foreground"}`}
            >
              {actionError || feedback}
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={pending}
                onClick={() => dialogRef.current?.close()}
              >
                Close
              </Button>
            </DialogFooter>
          </ModalDialog>,
          document.body,
        )}
    </>
  );
}
