import type { RevisionSnapshot } from "@/lib/bookings/revision";
import type { BookingAdjustmentEntity } from "@/lib/db/entities/booking-adjustment.entity";
import type { RefundReason } from "./refund-context";

export const refundReasonLabels: Record<RefundReason, string> = {
  booking_cancellation: "Cancellation refund",
  booking_price_reduction: "Price reduction refund",
  failed_adjustment_compensation: "Failed adjustment compensation",
  late_capture_compensation: "Late capture compensation",
};

export function revisionContext(revision: RevisionSnapshot) {
  return {
    revisionId: revision.id, bookingState: revision.bookingState,
    courtId: revision.courtId, locationId: revision.locationId,
    courtName: revision.courtName, locationName: revision.locationName, timezone: revision.timezone,
    bookingDate: revision.bookingDate, startMinute: revision.startMinute, endMinute: revision.endMinute,
    customerName: revision.customerName, customerEmail: revision.customerEmail, customerPhone: revision.customerPhone,
    totalAmountMinor: revision.totalAmountMinor, currency: revision.currency, paymentMethod: revision.paymentMethod,
  };
}

export function describeFinancialContext(input: {
  kind: "payment" | "refund" | "booking";
  revision: RevisionSnapshot;
  adjustment: (Pick<BookingAdjustmentEntity, "id" | "target" | "newTotal" | "kind"> & { currency: RevisionSnapshot["currency"] }) | null;
  adjustmentStatus: BookingAdjustmentEntity["status"] | null;
  appliedRevisionId: string | null;
  base: RevisionSnapshot | null;
  confirmationRevisionId: string | null;
  reason: RefundReason | null;
}) {
  const { kind, revision, adjustment, appliedRevisionId, base, reason } = input;
  if (adjustment && (!base || !input.adjustmentStatus)) throw new Error("Missing adjustment contract context");
  if (adjustment && input.adjustmentStatus === "applied" && !appliedRevisionId)
    throw new Error("Applied adjustment has no accepted revision");
  if (kind === "refund" && !reason) throw new Error("Missing refund reason");
  if (kind !== "refund" && !adjustment && revision.revisionNumber !== 1)
    throw new Error("Original request must reference the initial revision");
  if (kind === "payment" && adjustment && revision.id !== (appliedRevisionId ?? base?.id))
    throw new Error("Payment adjustment context does not match its recorded relationship");
  // Refund-backed changes record the contract in force when the refund was
  // requested (their base); earlier rows referenced the applied revision.
  const requestedFromBase = adjustment !== null && base !== null && revision.id === base.id;
  if (kind === "refund" && (reason === "booking_cancellation" && revision.kind !== "cancelled"
      && !(requestedFromBase && adjustment?.kind === "cancellation")
    || reason === "booking_price_reduction" && (revision.kind !== "rescheduled" || revision.id !== appliedRevisionId)
      && !(requestedFromBase && adjustment?.kind === "reschedule")
    || reason === "failed_adjustment_compensation" && (!base || revision.id !== base.id || appliedRevisionId !== null)
    || reason === "late_capture_compensation" && revision.revisionNumber !== 1))
    throw new Error("Refund reason does not match its recorded contract context");
  const source = kind === "refund" ? "refund_context" as const
    : adjustment ? appliedRevisionId ? "accepted_adjustment" as const : "adjustment_base" as const
    : "original_request" as const;
  const operationLabel = kind === "refund" && reason ? refundReasonLabels[reason]
    : adjustment ? "Modification payment" : kind === "booking" ? "Historical booking" : "Booking payment";
  return {
    operation_label: operationLabel,
    context: { ...revisionContext(revision), source,
      confirmationRevisionId: kind === "payment" && !adjustment ? input.confirmationRevisionId : null },
    previous_context: base && appliedRevisionId === revision.id ? revisionContext(base) : null,
    proposal: adjustment && input.adjustmentStatus ? { adjustmentId: adjustment.id, kind: adjustment.kind,
      courtId: adjustment.target.courtId, date: adjustment.target.date, startMinute: adjustment.target.startMinute,
      endMinute: adjustment.target.endMinute, courtName: adjustment.target.courtName, locationName: adjustment.target.locationName,
      timezone: adjustment.target.timezone, totalAmountMinor: adjustment.newTotal, currency: adjustment.currency,
      status: input.adjustmentStatus, acceptedRevisionId: appliedRevisionId } : null,
    customer_name: revision.customerName, customer_email: revision.customerEmail, customer_phone: revision.customerPhone,
    booking_total_minor: revision.totalAmountMinor,
    booking_date: revision.bookingDate, starts_at_minute: revision.startMinute, ends_at_minute: revision.endMinute,
    court_name: revision.courtName, location_name: revision.locationName, location_timezone: revision.timezone,
  };
}
