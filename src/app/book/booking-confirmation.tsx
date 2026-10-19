"use client";

import type { CoachingSelection } from "./coaching-selection";
import { refreshNotificationUnread } from "@/components/notification-unread";

import { toast } from "sonner";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Clock } from "lucide-react";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { fieldValidationErrors } from "@/lib/auth/validation";
import type { CheckoutPaymentStatus, PaymentMethod } from "@/lib/payments/domain";
import { customerBookingInputSchema } from "@/lib/bookings/domain";
import type { BookingContact } from "@/lib/bookings/domain";
import type { CalendarSelection } from "@/lib/courts/interval-selection";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";
import { Button } from "@/components/button";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/input";
import { DialogHeader, DialogFooter } from "@/components/dialog-layout";
import { BookingCancellationTerms } from "@/components/booking-cancellation-terms";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import { ModalDialog } from "@/components/modal-dialog";
import { abandonCheckoutAction, commitCustomerBookingAction, commitCoachingBookingAction } from "./actions";
import { OnlinePayment } from "./online-payment";
import { paymentHoldDurationSeconds, type OnlineCheckout } from "@/lib/payments/domain";

export type BookingSummaryDetails = { locationName: string; courtName: string; date: string;
  startMinute: number; endMinute: number; durationMinutes: number;
  priceMinor: number; currency: LocationCurrency;
  coaching?: { participantCount: 1 | 2; programName: string; coachName: string; coachingAmountMinor: number; courtAmountMinor: number; courtRentalIncluded: boolean } };

export function BookingSummary({ details }: { details: BookingSummaryDetails }) {
  const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${details.date}T00:00:00Z`));
  const items = [
    ["Location", details.locationName], ["Court", details.courtName], ["Date", dateLabel],
    ["Time", `${minuteToTime(details.startMinute)}–${minuteToTime(details.endMinute)}`],
    ["Duration", `${details.durationMinutes} min`],
    ...(details.coaching ? [["Program", details.coaching.programName],
      ["Participants", `${details.coaching.participantCount} ${details.coaching.participantCount === 1 ? "player" : "players"}`], ["Coach", details.coaching.coachName],
      ["Coaching price", formatMoney(details.coaching.coachingAmountMinor, details.currency)],
      ["Court rental", details.coaching.courtRentalIncluded ? "Included" : formatMoney(details.coaching.courtAmountMinor, details.currency)]] : []),
  ];
  return <div className="rounded-control border border-border bg-background"><dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
    {items.map(([label, value]) => <div key={label} className="contents">
      <dt className="font-medium text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums text-foreground">{value}</dd>
    </div>)}
  </dl><div className="flex items-baseline justify-between gap-3 border-t border-border px-4 py-3">
    <span className="text-sm font-semibold text-muted-foreground">Total</span>
    <strong className="font-heading text-2xl tabular-nums text-primary">{formatMoney(details.priceMinor, details.currency)}</strong>
  </div></div>;
}

const sectionHeading = "mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const paymentOption = "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-control border border-border bg-surface px-3 font-medium text-foreground transition-colors hover:border-border-strong has-[:checked]:border-primary has-[:checked]:bg-success-background has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";
const stickyActions = "sticky bottom-0 z-10 -mx-4 bg-surface px-4 pb-4 sm:-mx-6 sm:px-6 sm:pb-6";

export function BookingConfirmation({ selection, details, contact, onContactChange, onBack, onCommitted, onUnavailable, onAbandoned, cancellationNoticeMinutes, timezone, allowPayAtClub = false, onlinePaymentAvailable = false, authenticated = false, coaching }: {
  coaching?: Pick<CoachingSelection, "locationId" | "programId" | "coachId" | "durationMinutes">;
  authenticated?: boolean; onlinePaymentAvailable?: boolean; allowPayAtClub?: boolean; cancellationNoticeMinutes: number; timezone: string; selection: CalendarSelection; details: BookingSummaryDetails; contact: BookingContact;
  onContactChange: (contact: BookingContact) => void; onBack: () => void;
  onCommitted: (totalAmountMinor: number, currency: LocationCurrency, cancellationPolicy: ConfirmedCancellationPolicy | null, paymentMethod: PaymentMethod) => void;
  onUnavailable: (message: string) => void;
  onAbandoned: () => void;
}) {
  const titleId = useId();
  const fieldPrefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("online");
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reviewedPrice, setReviewedPrice] = useState({ totalAmountMinor: details.priceMinor, currency: details.currency });
  const [previousPrice, setPreviousPrice] = useState<typeof reviewedPrice | null>(null);
  const [checkout, setCheckout] = useState<{ payment: OnlineCheckout; expiresAt: string } | null>(null);
  const [confirmAbandonment, setConfirmAbandonment] = useState(false);
  const [checkoutStopped, setCheckoutStopped] = useState(false);
  const [paymentState, setPaymentState] = useState<CheckoutPaymentStatus>("pending");
  const [cancellationMessage, setCancellationMessage] = useState("");
  const dismissed = useRef(false);
  const cancellationStarted = useRef(false);
  const cancellationNotification = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    dismissed.current = false;
    return () => {
      dismissed.current = true;
      if (cancellationNotification.current !== undefined) toast.dismiss(cancellationNotification.current);
    };
  }, []);

  function requestClose() {
    dismissed.current = true;
    dialogRef.current?.close();
  }

  async function abandon() {
    if (!checkout || pendingRef.current) return;
    cancellationStarted.current = true;
    setCheckoutStopped(true); setConfirmAbandonment(false);
    pendingRef.current = true; setPending(true);
    setCancellationMessage("Requesting payment cancellation… You may close this window.");
    const notification = toast.loading("Cancelling payment…");
    cancellationNotification.current = notification;
    const timeout = window.setTimeout(() => {
      if (dismissed.current) return;
      const text = "Cancellation is taking longer than expected. Its outcome is uncertain. You may close this window; do not pay again yet.";
      setCancellationMessage(text); toast.warning(text, { id: notification });
    }, 15_000);
    try {
      const result = await abandonCheckoutAction({ attemptId: checkout.payment.attemptId, token: checkout.payment.token });
      if (result.ok) refreshNotificationUnread();
      if (dismissed.current) return;
      if (result.ok) {
        const text = result.paymentStatus === "refund_failed" ? "Booking cancelled, but the refund failed. Contact the club; do not pay again yet."
          : result.paymentStatus === "refunded" ? "Payment refunded. Booking cancelled."
          : result.paymentStatus === "refund_pending" ? "Booking cancelled. The captured payment refund is pending."
          : "Payment cancelled. Court hold released.";
        if (result.paymentStatus === "refund_failed") toast.error(text, { id: notification });
        else if (result.paymentStatus === "refund_pending") toast.info(text, { id: notification });
        else toast.success(text, { id: notification });
        setCheckout(null); onAbandoned();
      } else { setCancellationMessage(result.message); toast.error(result.message, { id: notification }); }
    } catch {
      if (!dismissed.current) {
        const text = "Unable to confirm payment cancellation. You may close this window; do not pay again until its outcome is established.";
        setCancellationMessage(text); toast.error(text, { id: notification });
      }
    } finally { window.clearTimeout(timeout); cancellationNotification.current = undefined;
      pendingRef.current = false; if (!dismissed.current) setPending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    if (paymentMethod === "online" && !onlinePaymentAvailable) { toast.error("Online payment is unavailable. Choose Pay at club if offered, or try again later."); return; }
    setFieldErrors({});
    const intent = { paymentMethod, courtId: selection.courtId, date: details.date,
      startMinute: selection.startMinute, endMinute: selection.endMinute, ...contact,
      expectedTotalAmountMinor: reviewedPrice.totalAmountMinor, expectedCurrency: reviewedPrice.currency };
    const parsed = customerBookingInputSchema.safeParse(intent);
    if (!parsed.success) {
      setFieldErrors(fieldValidationErrors(parsed.error));
      return;
    }
    pendingRef.current = true; setPending(true);
    const notification = toast.loading("Submitting booking…");
    cancellationNotification.current = notification;
    const timeout = window.setTimeout(() => {
      if (!dismissed.current) toast.warning("Booking submission is taking longer than expected. You may close this window; do not submit again yet.", { id: notification });
    }, 15_000);
    try {
      const result = coaching ? await commitCoachingBookingAction({ locationId: coaching.locationId,
        programId: coaching.programId, coachId: coaching.coachId, courtId: parsed.data.courtId, date: parsed.data.date,
        startMinute: parsed.data.startMinute, durationMinutes: coaching.durationMinutes,
        customerName: parsed.data.customerName, customerEmail: parsed.data.customerEmail, customerPhone: parsed.data.customerPhone,
        expectedTotalAmountMinor: parsed.data.expectedTotalAmountMinor, expectedCurrency: parsed.data.expectedCurrency })
        : await commitCustomerBookingAction(parsed.data);
      if (result.ok && result.status === "confirmed") refreshNotificationUnread();
      if (dismissed.current) return;
      if (result.ok) {
        if (result.status === "pending_payment") {
          toast.info("Court held. Complete payment to confirm your booking.", { id: notification });
          setCheckout({ payment: result.checkout, expiresAt: result.holdExpiresAt });
        } else {
          toast.success("Booking confirmed.", { id: notification });
          onCommitted(result.totalAmountMinor, result.currency, result.cancellationPolicy, paymentMethod);
        }
      } else if ("reason" in result) {
        toast.dismiss(notification);
        if (coaching) { onUnavailable("The lesson price has changed. Please review the current lesson prices and select your time again."); return; }
        setPreviousPrice(reviewedPrice);
        setReviewedPrice({ totalAmountMinor: result.totalAmountMinor, currency: result.currency });
      } else if (result.availabilityChanged) {
        toast.dismiss(notification);
        onUnavailable(`${result.message} Please choose another time.`);
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        if (Object.values(result.fieldErrors ?? {}).some(Boolean)) toast.dismiss(notification);
        else toast.error(result.message, { id: notification });
      }
    } catch {
      if (!dismissed.current) toast.error("Unable to confirm the booking. Please try again.", { id: notification });
    } finally { window.clearTimeout(timeout); cancellationNotification.current = undefined;
      pendingRef.current = false; if (!dismissed.current) setPending(false); }
  }

  const fields = [
    ["customerName", "Name", "text", "name"],
    ["customerEmail", "Email", "email", "email"],
    ["customerPhone", "Phone", "tel", "tel"],
  ] as const;
  if (typeof document === "undefined") return null;
  return createPortal(<ModalDialog ref={dialogRef} active aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); requestClose(); }}
    onClose={() => {
      dismissed.current = true;
      if (checkout) {
        toast.warning("Checkout closed. This does not confirm payment cancellation. Do not pay again until the payment outcome is established.");
        onAbandoned();
      } else {
        if (pendingRef.current) toast.warning("Booking submission may still be processing. Do not submit another booking until its outcome is established.");
        onBack();
      }
    }}
    className="fixed inset-0 m-auto w-[calc(100%-1.5rem)] max-w-lg rounded-card border border-border bg-surface px-4 py-0 text-foreground shadow-floating backdrop:bg-foreground/50 sm:w-[calc(100%-2rem)] sm:px-6">
    {/* Header and actions stay in view while the details scroll on small screens. */}
    <div className="sticky top-0 z-10 -mx-4 bg-surface px-4 pt-4 sm:-mx-6 sm:px-6 sm:pt-6">
      <DialogHeader titleId={titleId} title={checkout ? "Complete your payment" : previousPrice ? "Price changed" : "Confirm your booking"} onClose={requestClose} />
    </div>
    {previousPrice && <div role="alert" className="mt-4 flex gap-2.5 rounded-control border border-border-strong bg-warning-background px-3 py-2.5 text-sm text-foreground">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" /><div className="min-w-0">
      <p>The price for this booking has changed. Please review the new total before confirming.</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular-nums">
        <dt>Previous total</dt><dd className="font-semibold">{formatMoney(previousPrice.totalAmountMinor, previousPrice.currency)}</dd>
        <dt>New total</dt><dd className="font-semibold">{formatMoney(reviewedPrice.totalAmountMinor, reviewedPrice.currency)}</dd>
      </dl>
    </div></div>}
    <section aria-label="Booking details" className="mt-4"><h3 className={sectionHeading}>Booking details</h3><BookingSummary details={{ ...details, priceMinor: reviewedPrice.totalAmountMinor, currency: reviewedPrice.currency }} /></section>
    <BookingCancellationTerms noticeMinutes={cancellationNoticeMinutes} timezone={timezone} guest={!authenticated} />
    {checkout ? <>
      {!checkoutStopped && <OnlinePayment checkout={checkout.payment} holdExpiresAt={checkout.expiresAt} disabled={confirmAbandonment || pending}
        onPaymentStatus={setPaymentState}
        onConfirmed={(amount, currency, policy) => {
          if (!dismissed.current && !cancellationStarted.current) onCommitted(amount, currency, policy, "online");
        }} />}
      {cancellationMessage && <p role="status" className="mt-4 flex gap-2 rounded-control border border-border-strong bg-warning-background px-3 py-2.5 text-sm font-semibold text-foreground"><Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" /><span>{cancellationMessage}</span></p>}
      {confirmAbandonment && <p className="mt-4 flex gap-2 rounded-control border border-border-strong bg-warning-background px-3 py-2.5 text-sm font-semibold text-foreground"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" /><span>Cancel payment? A captured payment will require a refund.</span></p>}
      <div className={stickyActions}><DialogFooter>
        <Button type="button" variant="secondary" onClick={requestClose}>Close</Button>
        {confirmAbandonment ? <>
          {!checkoutStopped && (paymentState === "pending" || paymentState === "processing") && <Button type="button" variant="secondary" onClick={() => setConfirmAbandonment(false)}>Keep paying</Button>}
          <Button type="button" disabled={pending} aria-busy={pending} onClick={() => void abandon()}>{pending ? "Cancelling…" : "Cancel payment"}</Button>
        </> : <Button type="button" variant="secondary" disabled={pending} onClick={() => {
          if (checkoutStopped) void abandon(); else setConfirmAbandonment(true);
        }}>{pending ? "Cancelling…" : checkoutStopped ? "Retry cancellation" : "Cancel payment"}</Button>}
      </DialogFooter></div>
    </> : <form noValidate onSubmit={submit} className="mt-5">
      <section className="grid gap-3 sm:grid-cols-2" aria-label="Customer contact"><h3 className={`${sectionHeading} sm:col-span-2`}>Customer details</h3>
      {fields.map(([key, label, type, autoComplete]) => <div key={key} className={key === "customerName" ? "sm:col-span-2" : undefined}><FormField label={label} htmlFor={`${fieldPrefix}-${key}`}
        error={fieldErrors[key]} errorId={`${fieldPrefix}-${key}-error`}>
        <Input id={`${fieldPrefix}-${key}`} name={key} className="max-sm:text-base" type={type} autoComplete={autoComplete} required
          value={contact[key]} disabled={pending} aria-invalid={Boolean(fieldErrors[key])}
          aria-describedby={fieldErrors[key] ? `${fieldPrefix}-${key}-error` : undefined}
          onBlur={(event) => {
            const parsed = customerBookingInputSchema.shape[key].safeParse(event.currentTarget.value);
            setFieldErrors((current) => ({ ...current, [key]: parsed.success ? "" : parsed.error.issues[0].message }));
          }}
          onChange={(event) => { onContactChange({ ...contact, [key]: event.target.value });
            const parsed = customerBookingInputSchema.shape[key].safeParse(event.target.value);
            setFieldErrors((current) => current[key] === undefined ? current
              : { ...current, [key]: parsed.success ? "" : parsed.error.issues[0].message }); }} />
      </FormField></div>)}
      </section>
      <fieldset disabled={pending} className="mt-5 text-sm">
        <legend className={sectionHeading}>Payment method</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={paymentOption}><input type="radio" name="paymentMethod" value="online" disabled={!onlinePaymentAvailable} checked={paymentMethod === "online"} onChange={() => setPaymentMethod("online")} className="size-4 accent-primary" />Online payment</label>
          {!coaching && allowPayAtClub && <label className={paymentOption}><input type="radio" name="paymentMethod" value="pay_at_club" checked={paymentMethod === "pay_at_club"} onChange={() => setPaymentMethod("pay_at_club")} className="size-4 accent-primary" />Pay at club</label>}
        </div>
        {!onlinePaymentAvailable && <p className="mt-2 text-muted-foreground">Online payment is currently unavailable.</p>}
        {paymentMethod === "online" && onlinePaymentAvailable && <p className="mt-2 flex gap-2 text-muted-foreground"><Clock aria-hidden className="mt-0.5 size-4 shrink-0" /><span>Continue to secure payment. Your court is held for {paymentHoldDurationSeconds / 60} minutes while you pay.</span></p>}
      </fieldset>
      <div className={stickyActions}><DialogFooter>
        <Button type="button" variant="secondary" fullWidth={false} disabled={pending} onClick={() => dialogRef.current?.close()}>Back</Button>
        <Button type="submit" fullWidth={false} disabled={pending || (paymentMethod === "online" && !onlinePaymentAvailable)} aria-busy={pending}>{pending ? "Submitting…" : paymentMethod === "online" ? "Continue to payment" : "Confirm booking"}</Button>
      </DialogFooter></div>
    </form>}
  </ModalDialog>, document.body);
}
