"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { DetailSection } from "@/components/dialog-layout";
import { StatusBadge } from "@/components/status-badge";
import type { OwnBookingPayment } from "@/lib/bookings/personal";
import { formatMoney } from "@/lib/pricing/money";
import { loadOwnBookingPaymentAction } from "./bookings/actions";
import { LoadingStatus } from "@/components/loading-status";

const stateBadges = {
  completed: { tone: "success", label: "Completed" },
  pending: { tone: "warning", label: "Processing" },
  failed: { tone: "danger", label: "Failed" },
} as const;

// Loaded only when a booking dialog opens; the server checks ownership.
export function BookingPayment({ bookingId }: { bookingId: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof loadOwnBookingPaymentAction>> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    loadOwnBookingPaymentAction(bookingId).then((value) => { if (!disposed) setResult(value); })
      .catch(() => { if (!disposed) setResult({ ok: false, message: "Payment details are unavailable. Try again." }); });
    return () => { disposed = true; };
  }, [bookingId, attempt]);

  if (!result) return <section aria-label="Payment" aria-busy="true" className="mt-4">
    <h3 className="mb-2 text-sm font-semibold text-primary">Payment</h3>
    <LoadingStatus label="Loading payment details…" />
  </section>;
  if (!result.ok) return <section aria-label="Payment" className="mt-4">
    <h3 className="mb-2 text-sm font-semibold text-primary">Payment</h3>
    <p className="text-sm text-muted-foreground">{result.message}{" "}
      <Button type="button" variant="text" onClick={() => { setResult(null); setAttempt((value) => value + 1); }} className="font-semibold underline">Retry</Button></p>
  </section>;
  return <PaymentSummary payment={result.payment} />;
}

function PaymentSummary({ payment }: { payment: OwnBookingPayment }) {
  const money = (amount: number) => formatMoney(amount, payment.currency);
  const date = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: payment.timezone }).format(new Date(value));
  const online = payment.method === "online";
  return <>
    <DetailSection title="Payment">
      <dt className="text-muted-foreground">Method</dt><dd>{online ? "Online payment" : "Pay at club"}</dd>
      {(online || payment.paid > 0) && <><dt className="text-muted-foreground">Paid</dt><dd className="tabular-nums">{money(payment.paid)}</dd></>}
      {payment.refunded > 0 && <><dt className="text-muted-foreground">Refunded</dt><dd className="tabular-nums">−{money(payment.refunded)}</dd></>}
      {payment.refundPending > 0 && <><dt className="text-muted-foreground">Refund processing</dt>
        <dd className="tabular-nums">{money(payment.refundPending)} <span className="text-muted-foreground">· not yet confirmed</span></dd></>}
      {payment.outstanding > 0 && <><dt className="text-muted-foreground">Outstanding</dt><dd className="font-semibold tabular-nums text-primary">{money(payment.outstanding)}</dd></>}
      {payment.dueAtClub > 0 && <><dt className="text-muted-foreground">Due at club</dt><dd className="font-semibold tabular-nums text-primary">{money(payment.dueAtClub)}</dd></>}
    </DetailSection>
    {payment.operations.length > 0 && <ul aria-label="Payment history" className="mt-2 divide-y divide-border rounded-control border border-border text-sm">
      {payment.operations.map((operation, index) => <li key={index} className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="min-w-0">
          <span className="block font-medium">{operation.label}</span>
          {operation.at && <span className="block text-xs text-muted-foreground">{date(operation.at)}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`tabular-nums ${operation.state === "completed" ? "font-semibold" : "text-muted-foreground"}`}>
            {operation.kind === "refund" ? "−" : "+"}{money(operation.amount)}</span>
          <StatusBadge tone={stateBadges[operation.state].tone}>{stateBadges[operation.state].label}</StatusBadge>
        </span>
      </li>)}
    </ul>}
    {!online && <p className="mt-2 text-xs text-muted-foreground">Payments made at the club are not shown here.</p>}
  </>;
}
