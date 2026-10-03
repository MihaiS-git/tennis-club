"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { fieldValidationErrors } from "@/lib/auth/validation";
import { customerBookingInputSchema } from "@/lib/bookings/domain";
import type { BookingContact } from "@/lib/bookings/domain";
import type { CalendarSelection } from "@/lib/courts/interval-selection";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";
import { Button } from "@/components/button";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/input";
import { ModalDialog } from "@/components/modal-dialog";
import { confirmCustomerBookingAction } from "./actions";

export type BookingSummaryDetails = { locationName: string; courtName: string; date: string;
  startMinute: number; endMinute: number; durationMinutes: number;
  priceMinor: number; currency: LocationCurrency };

export function BookingSummary({ details }: { details: BookingSummaryDetails }) {
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${details.date}T00:00:00Z`));
  const items = [
    ["Location", details.locationName], ["Court", details.courtName], ["Date", dateLabel],
    ["Time", `${minuteToTime(details.startMinute)}–${minuteToTime(details.endMinute)}`],
    ["Duration", `${details.durationMinutes} min`], ["Total", formatMoney(details.priceMinor, details.currency)],
  ];
  return <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-control bg-surface-muted p-4 text-sm">
    {items.map(([label, value]) => <div key={label} className="contents">
      <dt className="font-medium text-muted-foreground">{label}</dt><dd className="font-semibold text-foreground">{value}</dd>
    </div>)}
  </dl>;
}

export function BookingConfirmation({ selection, details, contact, onContactChange, onBack, onConfirmed, onUnavailable }: {
  selection: CalendarSelection; details: BookingSummaryDetails; contact: BookingContact;
  onContactChange: (contact: BookingContact) => void; onBack: () => void;
  onConfirmed: (totalAmountMinor: number, currency: LocationCurrency) => void;
  onUnavailable: (message: string) => void;
}) {
  const titleId = useId();
  const fieldPrefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [reviewedPrice, setReviewedPrice] = useState({ totalAmountMinor: details.priceMinor, currency: details.currency });
  const [previousPrice, setPreviousPrice] = useState<typeof reviewedPrice | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    setFieldErrors({}); setFormError("");
    const intent = { courtId: selection.courtId, date: details.date,
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
      const result = await confirmCustomerBookingAction(parsed.data);
      if (result.ok) {
        onConfirmed(result.totalAmountMinor, result.currency);
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
    onCancel={(event) => { if (pending) event.preventDefault(); }}
    onClose={() => { if (!pendingRef.current) onBack(); }}
    className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-lg rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
    <h2 id={titleId} className="font-heading text-xl font-semibold text-primary">{previousPrice ? "Price changed" : "Confirm your booking"}</h2>
    {previousPrice && <div role="alert" className="mt-3 rounded-control bg-warning-background px-3 py-2 text-sm text-foreground">
      <p>The price for this booking has changed. Please review the new total before confirming.</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>Previous total</dt><dd className="font-semibold">{formatMoney(previousPrice.totalAmountMinor, previousPrice.currency)}</dd>
        <dt>New total</dt><dd className="font-semibold">{formatMoney(reviewedPrice.totalAmountMinor, reviewedPrice.currency)}</dd>
      </dl>
    </div>}
    <div className="mt-4"><BookingSummary details={{ ...details, priceMinor: reviewedPrice.totalAmountMinor, currency: reviewedPrice.currency }} /></div>
    <form noValidate onSubmit={submit} className="mt-5 space-y-3">
      <h3 className="font-heading text-base font-semibold text-primary">Customer details</h3>
      <p role={formError ? "alert" : undefined} className={`min-h-6 text-sm text-danger ${formError ? "rounded-control bg-danger-background px-2 py-1" : ""}`}>{formError}</p>
      {fields.map(([key, label, type, autoComplete]) => <FormField key={key} label={label} htmlFor={`${fieldPrefix}-${key}`}
        error={fieldErrors[key]} errorId={`${fieldPrefix}-${key}-error`}>
        <Input id={`${fieldPrefix}-${key}`} name={key} type={type} autoComplete={autoComplete} required
          value={contact[key]} disabled={pending} aria-invalid={Boolean(fieldErrors[key])}
          aria-describedby={fieldErrors[key] ? `${fieldPrefix}-${key}-error` : undefined}
          onChange={(event) => { onContactChange({ ...contact, [key]: event.target.value });
            setFieldErrors((current) => ({ ...current, [key]: "" })); }} />
      </FormField>)}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" fullWidth={false} disabled={pending} onClick={() => dialogRef.current?.close()}>Back</Button>
        <Button type="submit" fullWidth={false} disabled={pending} aria-busy={pending}>{pending ? "Confirming…" : "Confirm booking"}</Button>
      </div>
    </form>
  </ModalDialog>, document.body);
}
