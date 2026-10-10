"use client";

import { useCallback, useEffect, useState } from "react";
import { ReservationEditForm, type ReservationEditDraft } from "@/components/reservation-edit-form";
import type { AdminBooking, InternalLocation } from "@/lib/reservations/service";
import type { BookingEditContext } from "@/lib/bookings/reschedule";
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
  const [error, setError] = useState("");
  const key = draftKey(draft);
  const courtId = draft.selection?.courtId, startMinute = draft.selection?.startMinute, endMinute = draft.selection?.endMinute;
  useEffect(() => {
    let disposed = false;
    onQuote(null);
    if (!courtId || startMinute === undefined || endMinute === undefined) return;
    actions.quote({ id, expectedUpdatedAt: context.updated_at,
      expectedBookingUpdatedAt: context.booking_updated_at, courtId, date: draft.date, startMinute, endMinute,
      save: false, expectedTotal: null, priceAcknowledged: false }).then((result) => {
      if (disposed) return;
      if (result.ok) { onQuote({ key, total: result.totalAmountMinor }); setError(""); }
      else setError(result.message);
    }).catch(() => { if (!disposed) setError("Unable to calculate the new total. Choose the interval again."); });
    return () => { disposed = true; };
  }, [id, context.updated_at, context.booking_updated_at, courtId, draft.date, startMinute, endMinute, key, onQuote, actions]);
  const currentQuote = quote?.key === key ? quote : null;
  return <section aria-label="Booking price" className="rounded-control border border-border p-3 text-sm">
    <p>Current total: {formatMoney(context.total_amount_minor, currency)}</p>
    <p>New total: {currentQuote ? formatMoney(currentQuote.total, currency) : draft.selection ? "Calculating…" : "Choose an interval"}</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
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
  const [context, setContext] = useState<BookingEditContext | null>(null);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // Stable setter identity avoids restarting a quote on every render.
  const receiveQuote = useCallback((value: Quote | null) => { setQuote(value); setAcknowledged(false); }, []);
  useEffect(() => {
    let disposed = false;
    actions.load(booking.id, booking.booking_date).then((result) => {
      if (!disposed) setContext(result.booking);
    }).catch(() => { if (!disposed) setError("This booking is no longer available to edit. Close and reopen its details."); });
    return () => { disposed = true; };
  }, [booking.id, booking.booking_date, actions]);
  if (!context) return <div className="mt-4 text-sm"><p role={error ? "alert" : "status"}>{error || "Loading booking…"}</p>
    <button type="button" onClick={onCancel} className="mt-3 underline">Back to details</button></div>;
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
      const result = await actions.save({ ...editInput(booking.id, context, draft),
        save: true, expectedTotal: quote.total, priceAcknowledged: acknowledged });
      if (!result.ok && "reason" in result && result.reason === "price_changed" && result.totalAmountMinor !== undefined) {
        receiveQuote({ key: draftKey(draft), total: result.totalAmountMinor, requiresConfirmation: true });
      }
      return result;
    }} onSaved={onSaved} />;
}
