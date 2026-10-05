"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { fieldValidationErrors } from "@/lib/auth/validation";
import type { PaymentMethod } from "@/lib/payments/domain";
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
import { abandonCheckoutAction, commitCustomerBookingAction } from "./actions";
import { OnlinePayment } from "./online-payment";
import { paymentHoldDurationSeconds, type OnlineCheckout } from "@/lib/payments/domain";

export type BookingSummaryDetails = { locationName: string; courtName: string; date: string;
  startMinute: number; endMinute: number; durationMinutes: number;
  priceMinor: number; currency: LocationCurrency };

export function BookingSummary({ details }: { details: BookingSummaryDetails }) {
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${details.date}T00:00:00Z`));
  const items = [
    ["Location", details.locationName], ["Court", details.courtName], ["Date", dateLabel],
    ["Time", `${minuteToTime(details.startMinute)}–${minuteToTime(details.endMinute)}`],
    ["Duration", `${details.durationMinutes} min`],
  ];
  return <div className="rounded-control bg-surface-muted"><dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
    {items.map(([label, value]) => <div key={label} className="contents">
      <dt className="font-medium text-muted-foreground">{label}</dt><dd className="font-semibold text-foreground">{value}</dd>
    </div>)}
  </dl><div className="flex items-baseline justify-between gap-3 border-t border-border px-4 py-3">
    <span className="text-sm font-semibold text-muted-foreground">Total</span>
    <strong className="text-2xl text-primary">{formatMoney(details.priceMinor, details.currency)}</strong>
  </div></div>;
}

export function BookingConfirmation({ selection, details, contact, onContactChange, onBack, onCommitted, onUnavailable, onAbandoned, cancellationNoticeMinutes, timezone, allowPayAtClub = false, onlinePaymentAvailable = false }: {
  onlinePaymentAvailable?: boolean; allowPayAtClub?: boolean; cancellationNoticeMinutes: number; timezone: string; selection: CalendarSelection; details: BookingSummaryDetails; contact: BookingContact;
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
  const [formError, setFormError] = useState("");
  const [reviewedPrice, setReviewedPrice] = useState({ totalAmountMinor: details.priceMinor, currency: details.currency });
  const [previousPrice, setPreviousPrice] = useState<typeof reviewedPrice | null>(null);
  const [checkout, setCheckout] = useState<{ payment: OnlineCheckout; expiresAt: string } | null>(null);
  const [confirmAbandonment, setConfirmAbandonment] = useState(false);

  function requestClose() {
    if (pendingRef.current) return;
    if (checkout) { setFormError(""); setConfirmAbandonment((showing) => !showing); }
    else dialogRef.current?.close();
  }

  async function abandon() {
    if (!checkout || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setFormError("");
    try {
      const result = await abandonCheckoutAction({ attemptId: checkout.payment.attemptId, token: checkout.payment.token });
      if (result.ok) { setCheckout(null); onAbandoned(); }
      else setFormError(result.message);
    } catch { setFormError("Unable to cancel payment. Please try again."); }
    finally { pendingRef.current = false; setPending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    if (paymentMethod === "online" && !onlinePaymentAvailable) { setFormError("Online payment is unavailable. Choose Pay at club if offered, or try again later."); return; }
    setFieldErrors({}); setFormError("");
    const intent = { paymentMethod, courtId: selection.courtId, date: details.date,
      startMinute: selection.startMinute, endMinute: selection.endMinute, ...contact,
      expectedTotalAmountMinor: reviewedPrice.totalAmountMinor, expectedCurrency: reviewedPrice.currency };
    const parsed = customerBookingInputSchema.safeParse(intent);
    if (!parsed.success) {
      setFieldErrors(fieldValidationErrors(parsed.error));
      setFormError("Check the customer details.");
      return;
    }
    pendingRef.current = true; setPending(true);
    try {
      const result = await commitCustomerBookingAction(parsed.data);
      if (result.ok) {
        if (result.status === "pending_payment") {
          setCheckout({ payment: result.checkout, expiresAt: result.holdExpiresAt });
        } else {
          onCommitted(result.totalAmountMinor, result.currency, result.cancellationPolicy, paymentMethod);
        }
      } else if ("reason" in result) {
        setPreviousPrice(reviewedPrice);
        setReviewedPrice({ totalAmountMinor: result.totalAmountMinor, currency: result.currency });
      } else if (result.availabilityChanged) {
        onUnavailable(`${result.message} Please choose another time.`);
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        setFormError(result.message);
      }
    } catch {
      setFormError("Unable to confirm the booking. Please try again.");
    } finally { pendingRef.current = false; setPending(false); }
  }

  const fields = [
    ["customerName", "Name", "text", "name"],
    ["customerEmail", "Email", "email", "email"],
    ["customerPhone", "Phone", "tel", "tel"],
  ] as const;
  if (typeof document === "undefined") return null;
  return createPortal(<ModalDialog ref={dialogRef} active aria-labelledby={titleId}
    onCancel={(event) => { if (pending || checkout) { event.preventDefault(); requestClose(); } }}
    onClose={() => {
      if (checkout) { dialogRef.current?.showModal(); requestClose(); }
      else if (!pendingRef.current) onBack();
    }}
    className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-lg rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
    <DialogHeader titleId={titleId} title={checkout ? "Complete your payment" : previousPrice ? "Price changed" : "Confirm your booking"} disabled={pending} onClose={requestClose} />
    {previousPrice && <div role="alert" className="mt-3 rounded-control bg-warning-background px-3 py-2 text-sm text-foreground">
      <p>The price for this booking has changed. Please review the new total before confirming.</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>Previous total</dt><dd className="font-semibold">{formatMoney(previousPrice.totalAmountMinor, previousPrice.currency)}</dd>
        <dt>New total</dt><dd className="font-semibold">{formatMoney(reviewedPrice.totalAmountMinor, reviewedPrice.currency)}</dd>
      </dl>
    </div>}
    <div className="mt-4"><BookingSummary details={{ ...details, priceMinor: reviewedPrice.totalAmountMinor, currency: reviewedPrice.currency }} /></div>
    <BookingCancellationTerms noticeMinutes={cancellationNoticeMinutes} timezone={timezone} />
    {checkout ? <>
      <OnlinePayment checkout={checkout.payment} holdExpiresAt={checkout.expiresAt} disabled={confirmAbandonment || pending}
        onConfirmed={(amount, currency, policy) => onCommitted(amount, currency, policy, "online")} />
      <p role={formError ? "alert" : undefined} className="min-h-6 text-sm text-danger">{formError}</p>
      {confirmAbandonment && <p className="text-sm font-semibold">Cancel payment? Your held court will be released.</p>}
      <DialogFooter>
        {confirmAbandonment ? <>
          <Button type="button" variant="secondary" disabled={pending} onClick={requestClose}>Keep paying</Button>
          <Button type="button" disabled={pending} aria-busy={pending} onClick={() => void abandon()}>{pending ? "Cancelling…" : "Cancel payment"}</Button>
        </> : <Button type="button" variant="secondary" onClick={requestClose}>Cancel payment</Button>}
      </DialogFooter>
    </> : <form noValidate onSubmit={submit} className="mt-5">
      <section className="space-y-3" aria-label="Customer contact"><h3 className="font-heading text-base font-semibold text-primary">Customer details</h3>
      <p role={formError ? "alert" : undefined} className={`min-h-6 text-sm text-danger ${formError ? "rounded-control bg-danger-background px-2 py-1" : ""}`}>{formError}</p>
      {fields.map(([key, label, type, autoComplete]) => <FormField key={key} label={label} htmlFor={`${fieldPrefix}-${key}`}
        error={fieldErrors[key]} errorId={`${fieldPrefix}-${key}-error`}>
        <Input id={`${fieldPrefix}-${key}`} name={key} type={type} autoComplete={autoComplete} required
          value={contact[key]} disabled={pending} aria-invalid={Boolean(fieldErrors[key])}
          aria-describedby={fieldErrors[key] ? `${fieldPrefix}-${key}-error` : undefined}
          onChange={(event) => { onContactChange({ ...contact, [key]: event.target.value });
            setFieldErrors((current) => ({ ...current, [key]: "" })); }} />
      </FormField>)}
      </section>
      <fieldset disabled={pending} className="mt-4 space-y-2 text-sm">
        <legend className="mb-2 font-semibold">Payment method</legend>
        <label className="flex items-center gap-2"><input type="radio" name="paymentMethod" value="online" disabled={!onlinePaymentAvailable} checked={paymentMethod === "online"} onChange={() => setPaymentMethod("online")} />Online payment</label>
        {allowPayAtClub && <label className="flex items-center gap-2"><input type="radio" name="paymentMethod" value="pay_at_club" checked={paymentMethod === "pay_at_club"} onChange={() => setPaymentMethod("pay_at_club")} />Pay at club</label>}
        {!onlinePaymentAvailable && <p className="text-muted-foreground">Online payment is currently unavailable.</p>}
        {paymentMethod === "online" && onlinePaymentAvailable && <p className="text-muted-foreground">Continue to secure payment. Your court is held for {paymentHoldDurationSeconds / 60} minutes while you pay.</p>}
      </fieldset>
      <DialogFooter>
        <Button type="button" variant="secondary" fullWidth={false} disabled={pending} onClick={() => dialogRef.current?.close()}>Back</Button>
        <Button type="submit" fullWidth={false} disabled={pending || (paymentMethod === "online" && !onlinePaymentAvailable)} aria-busy={pending}>{pending ? "Submitting…" : paymentMethod === "online" ? "Continue to payment" : "Confirm booking"}</Button>
      </DialogFooter>
    </form>}
  </ModalDialog>, document.body);
}
