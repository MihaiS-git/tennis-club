"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ReservationEditForm, type ReservationEditDraft } from "@/components/reservation-edit-form";
import type { AdminBooking, InternalLocation } from "@/lib/reservations/service";
import type { BookingEditContext } from "@/lib/bookings/reschedule";
import { OnlinePayment } from "@/app/book/online-payment";
import { abandonCheckoutAction } from "@/app/book/actions";
import type { BookingRescheduleResult } from "@/lib/bookings/reschedule";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { formatMoney } from "@/lib/pricing/money";
import { loadAdminBookingEditDayAction, quoteAdminBookingAction, rescheduleAdminBookingAction } from "./actions";

export type BookingEditActions = {
  load: typeof loadAdminBookingEditDayAction;
  quote: typeof quoteAdminBookingAction;
  save: typeof rescheduleAdminBookingAction;
};
const adminActions: BookingEditActions = { load: loadAdminBookingEditDayAction, quote: quoteAdminBookingAction, save: rescheduleAdminBookingAction };

type Quote = { key: string; total: number; requiresConfirmation?: boolean };
function draftKey(draft: ReservationEditDraft) {
  return `${draft.date}/${draft.selection?.courtId}/${draft.selection?.startMinute}/${draft.selection?.endMinute}`;
}
function editInput(id: string, context: BookingEditContext, draft: ReservationEditDraft) {
  return { id, expectedUpdatedAt: context.updated_at, expectedBookingUpdatedAt: context.booking_updated_at,
    courtId: draft.selection?.courtId, date: draft.date, startMinute: draft.selection?.startMinute,
    endMinute: draft.selection?.endMinute };
}

function BookingPrice({ id, context, draft, currency, quote, acknowledged, onQuote, onAcknowledge, actions, pending }: {
  pending: boolean;
  actions: BookingEditActions;
  id: string; context: BookingEditContext; draft: ReservationEditDraft; currency: AdminBooking["currency"];
  quote: Quote | null; acknowledged: boolean; onQuote: (quote: Quote | null) => void; onAcknowledge: (value: boolean) => void;
}) {
  const key = draftKey(draft);
  const courtId = draft.selection?.courtId, startMinute = draft.selection?.startMinute, endMinute = draft.selection?.endMinute;
  useEffect(() => {
    let disposed = false;
    onQuote(null);
    if (!courtId || startMinute === undefined || endMinute === undefined) return;
    let notification: string | number | undefined;
    actions.quote({ id, expectedUpdatedAt: context.updated_at,
      expectedBookingUpdatedAt: context.booking_updated_at, courtId, date: draft.date, startMinute, endMinute,
      save: false, expectedTotal: null, priceAcknowledged: false }).then((result) => {
      if (disposed) return;
      if (result.ok) { onQuote({ key, total: result.totalAmountMinor }); }
      else notification = toast.error(result.message);
    }).catch(() => { if (!disposed) notification = toast.error("Unable to calculate the new total. Choose the interval again."); });
    return () => { disposed = true; if (notification !== undefined) toast.dismiss(notification); };
  }, [id, context.updated_at, context.booking_updated_at, courtId, draft.date, startMinute, endMinute, key, onQuote, actions]);
  const currentQuote = quote?.key === key ? quote : null;
  return <section aria-label="Booking price" className="rounded-control border border-border p-3 text-sm">
    <p>Current total: {formatMoney(context.total_amount_minor, currency)}</p>
    <p>New total: {currentQuote ? formatMoney(currentQuote.total, currency) : draft.selection ? "Calculating booking total…" : "Choose an interval"}</p>
    {currentQuote && currentQuote.total !== context.total_amount_minor && context.payment_method === "online" && <p className="mt-2 font-semibold">
      {currentQuote.total > context.total_amount_minor ? "Additional amount payable: " : "Eligible refund: "}
      {formatMoney(Math.abs(currentQuote.total - context.total_amount_minor), currency)}
    </p>}
    {context.refunds?.map(refund => <p key={refund.id} className="mt-2">
      Refund {formatMoney(refund.amount, currency)}: {refund.status === "succeeded" ? "completed" : refund.status === "failed" ? "failed; the club can retry it" : "pending or awaiting retry"}
    </p>)}
    {currentQuote && (currentQuote.total !== context.total_amount_minor || currentQuote.requiresConfirmation) && <label className="mt-2 flex items-center gap-2">
      <input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => onAcknowledge(event.target.checked)} />
      I confirm the new total of {formatMoney(currentQuote.total, currency)}.
    </label>}
  </section>;
}

export function BookingEditForm({ booking, location, onCancel, onSaved, onPendingChange, actions = adminActions }: {
  booking: Pick<AdminBooking, "id" | "booking_date" | "currency">; location?: Pick<InternalLocation, "name" | "courts">; actions?: BookingEditActions; onCancel: () => void;
  onSaved: () => Promise<void>; onPendingChange: (value: boolean) => void;
}) {
  const active = useRef(true);
  const [context, setContext] = useState<BookingEditContext | null>(null);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [adjustment, setAdjustment] = useState<Extract<BookingRescheduleResult, { ok: true }> | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [paymentEnded, setPaymentEnded] = useState(false);
  // Stable setter identity avoids restarting a quote on every render.
  const receiveQuote = useCallback((value: Quote | null) => { setQuote(value); setAcknowledged(false); }, []);
  useEffect(() => {
    let disposed = false;
    active.current = true;
    // Keep read progress inside its component. Sonner queues publication with a
    // timer but dismissal with animation frames; fast completion/disposal can
    // dismiss before publication and leave an infinite loading toast on screen.
    let notification: string | number | undefined;
    actions.load(booking.id, booking.booking_date).then((result) => {
      if (!disposed) {
        setContext(result.booking);
        if (result.booking.pending_adjustment_id) setAdjustment({ ok: true,
          totalAmountMinor: result.booking.adjustment_total_minor ?? result.booking.total_amount_minor, adjustmentId: result.booking.pending_adjustment_id,
          adjustmentStatus: result.booking.adjustment_status ?? "pending", paymentRecoveryRequired: result.booking.payment_recovery_required, target: result.booking.adjustment_target, ...result.adjustment });
      }
    }).catch(() => { if (!disposed) {
      setError("This booking is no longer available to edit. Close and reopen its details.");
      notification = toast.error("This booking is no longer available to edit. Close and reopen its details.");
    } });
    return () => { active.current = false; disposed = true; if (notification !== undefined) toast.dismiss(notification); };
  }, [booking.id, booking.booking_date, actions]);
  if (!context) return <div className="mt-4 min-h-20 text-sm" aria-busy={!error}>
    <p role={error ? "alert" : "status"}>{error || "Loading booking…"}</p>
    <button type="button" onClick={onCancel} className="mt-3 underline">Back to details</button></div>;
  if (adjustment) return <section aria-label="Booking modification" className="mt-4 space-y-3 text-sm">
    {adjustment.target && <p>New interval: {context.location.courts.find(c => c.id === adjustment.target?.courtId)?.name ?? "Court"} · {adjustment.target.date} · {minuteToTime(adjustment.target.startMinute)}–{minuteToTime(adjustment.target.endMinute)}</p>}
    <p>Current total: {formatMoney(context.total_amount_minor, booking.currency)}</p>
    <p>New total: {formatMoney(adjustment.totalAmountMinor, booking.currency)}</p>
    <p className="font-semibold">{adjustment.totalAmountMinor >= context.total_amount_minor ? "Additional amount payable: " : "Eligible refund: "}
      {formatMoney(Math.abs(adjustment.totalAmountMinor - context.total_amount_minor), booking.currency)}</p>
    {adjustment.adjustmentStatus === "pending" ? <>
      <p>The modification is pending. Your original booking remains confirmed until payment and the change are verified.</p>
      {adjustment.checkout && adjustment.holdExpiresAt ? <OnlinePayment checkout={adjustment.checkout}
        holdExpiresAt={adjustment.holdExpiresAt} disabled={cancelling} confirmationMessage="Booking modification completed."
        onPaymentStatus={(status) => { if (["cancelled", "expired", "refunded", "refund_pending", "refund_failed"].includes(status)) setPaymentEnded(true); }}
        onConfirmed={() => { if (!active.current) return; void onSaved().catch(() => toast.warning("Booking modification completed. Unable to refresh its details.")); }} />
        : <button type="button" className="underline" onClick={() => {
          void actions.load(booking.id, booking.booking_date).then(result => {
            if (!active.current) return;
            if (result.adjustment) setAdjustment(current => current && ({ ...current, ...result.adjustment }));
            else toast.info("The payment is no longer pending. Close and reopen booking details.");
          }).catch(() => { if (active.current) toast.error("Unable to recover payment. Please try again."); });
        }}>Recover additional payment</button>}
      {adjustment.paymentUrl && <p><a href={adjustment.paymentUrl} target="_blank" rel="noreferrer" className="underline">Customer payment link</a></p>}
      {adjustment.checkout && !paymentEnded && <button type="button" disabled={cancelling} className="underline" onClick={() => {
        const checkout = adjustment.checkout;
        if (cancelling || !checkout) return;
        setCancelling(true);
        void abandonCheckoutAction({ attemptId: checkout.attemptId, token: checkout.token }).then(result => {
          if (!active.current) return;
          if (result.ok) { setPaymentEnded(true); toast.info("Modification cancelled. The original booking is preserved."); }
          else toast.warning(result.message);
        }).catch(() => { if (active.current) toast.warning("Cancellation outcome is uncertain. Reopen details to recover it."); })
          .finally(() => setCancelling(false));
      }}>Cancel modification</button>}
    </> : <>
      <p>{adjustment.adjustmentStatus === "applied" ? "Booking modification completed." : "Modification ended. The original booking was preserved."}</p>
      {adjustment.paymentRecoveryRequired && <>
        <p>The additional payment cancellation is still being checked. Do not pay again yet.</p>
        <button type="button" className="underline" onClick={() => {
          void actions.load(booking.id,booking.booking_date).then(result => {
            if (!active.current) return;
            if (!result.booking.pending_adjustment_id) void onSaved();
            else toast.warning("Payment outcome is still uncertain. Retry recovery shortly.");
          }).catch(() => { if (active.current) toast.warning("Unable to establish the payment outcome. Retry recovery shortly."); });
        }}>Recover payment outcome</button>
      </>}
      {adjustment.refundStatus && <p>Refund status: {adjustment.refundStatus === "succeeded" ? "Refund completed" : adjustment.refundStatus === "failed" ? "Refund failed; the club can retry it" : "Refund pending; the club can reconcile or retry it"}</p>}
    </>}
    <button type="button" className="underline" onClick={() => { if (adjustment.adjustmentStatus === "applied") void onSaved(); else onCancel(); }}>Close</button>
  </section>;
  const fixedLocation = location ?? context.location;
  return <ReservationEditForm reservation={{ ...context, id: booking.id, reason: null,
    location_name: fixedLocation.name, court_name: fixedLocation.courts.find((c) => c.id === context.court_id)?.name ?? "Court" }}
    inProgress={false} scheduleOnly loadAvailability={actions.load}
    onCancel={onCancel} onPendingChange={onPendingChange}
    canSave={(draft) => quote?.key === draftKey(draft)
      && (!(quote.total !== context.total_amount_minor || quote.requiresConfirmation) || acknowledged)}
    renderScheduleDetails={(draft, pending) => <BookingPrice id={booking.id} context={context} draft={draft} currency={booking.currency}
      actions={actions} pending={pending} quote={quote} acknowledged={acknowledged} onQuote={receiveQuote} onAcknowledge={setAcknowledged} />}
    onSave={async (draft) => {
      if (!quote || quote.key !== draftKey(draft)) return { ok: false, message: "Wait for the recalculated total before saving." };
      if ((quote.total !== context.total_amount_minor || quote.requiresConfirmation) && !acknowledged)
        return { ok: false, message: "Confirm the new total before saving." };
      const key = draftKey(draft);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const result = await actions.save({ requestId: request.current.id, ...editInput(booking.id, context, draft),
        save: true, expectedTotal: quote.total, priceAcknowledged: acknowledged });
      if (result.ok && result.adjustmentId) {
        setAdjustment(result);
        return { ok: true as const, pending: true, message: result.adjustmentStatus === "applied"
          ? result.refundStatus === "succeeded" ? "Booking updated and refund completed." : "Booking updated. The refund obligation is recorded."
          : result.adjustmentStatus === "pending" ? "Complete the additional payment to update your booking."
          : "The previous modification has ended. Check its financial outcome." };
      }
      if (!result.ok && "reason" in result && result.reason === "price_changed" && result.totalAmountMinor !== undefined) {
        receiveQuote({ key: draftKey(draft), total: result.totalAmountMinor, requiresConfirmation: true });
      }
      return result;
    }} onSaved={onSaved} />;
}
