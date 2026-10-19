import { z } from "zod";
import type { StatusTone } from "@/components/status-badge";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import type { BookingAdjustmentEntity } from "@/lib/db/entities/booking-adjustment.entity";
import type { summarizeReportedFinancials } from "@/lib/payments/financials";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { RevisionSnapshot } from "./revision";
import { bookingStatusLabels, type BookingStatus } from "./admin-query";

// Read-only Admin presentation of persisted booking records. Every recorded event
// comes from an immutable revision or a stored change request; prices are the
// snapshotted totals, never a repricing under current rules.
export type HistorySchedule = {
  courtId: string; locationName: string; courtName: string; timezone: string; date: string; startMinute: number; endMinute: number;
  total: number; currency: LocationCurrency;
};
export type BookingHistoryEvent = {
  key: string; kind: "created" | "confirmed" | "change" | "cancelled" | "request" | "status"; label: string; detail: string | null;
  // null when the change exists only as the current booking status.
  at: string | null; recorded: boolean; requestedAt: string | null;
  previous: HistorySchedule | null; next: HistorySchedule | null;
  status: { label: string; tone: StatusTone };
};
type HistoryRevision = Pick<RevisionSnapshot, "id" | "revisionNumber" | "kind" | "bookingState" | "courtId" | "locationName" | "courtName"
  | "timezone" | "bookingDate" | "startMinute" | "endMinute" | "totalAmountMinor" | "currency" | "paymentMethod"
  | "actorScope" | "recordedAt" | "adjustmentId" | "cancellationCause">;
type HistoryAdjustment = Pick<BookingAdjustmentEntity, "id" | "baseRevisionId" | "kind" | "scope" | "target" | "newTotal"
  | "currency" | "status" | "createdAt">;

const actors: Record<RevisionSnapshot["actorScope"], string> = {
  guest: "guest", customer: "customer", coach_owner: "coach", admin_owner: "administrator (own booking)",
  admin: "administrator", provider: "verified payment",
};
const stateStatus = {
  pending_payment: { label: "Awaiting payment", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const;
const requestStatus = {
  pending: { label: "Pending", tone: "warning" },
  unsuccessful: { label: "Failed", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
  cancelled: { label: "Withdrawn", tone: "neutral" },
  applied: { label: "Applied", tone: "success" },
} as const;
const cancellationCauses = {
  owner_cancelled: "Cancelled by the booking owner",
  admin_cancelled: "Cancelled by an administrator",
  checkout_abandoned: "Checkout abandoned before payment",
} as const;
const inferredStatus: Record<BookingStatus, string> = {
  confirmed: "Booking confirmed", pending_payment: "Awaiting payment", cancelled: "Booking cancelled",
  failed: "Checkout failed", expired: "Checkout expired",
};

function schedule(revision: HistoryRevision): HistorySchedule {
  return { courtId: revision.courtId, locationName: revision.locationName, courtName: revision.courtName, timezone: revision.timezone,
    date: revision.bookingDate, startMinute: revision.startMinute, endMinute: revision.endMinute,
    total: revision.totalAmountMinor, currency: revision.currency };
}
// Persisted court identity, not display names: distinct courts may share a name and
// a renamed court is still the same court.
const sameSchedule = (a: HistorySchedule, b: HistorySchedule) => a.courtId === b.courtId
  && a.date === b.date && a.startMinute === b.startMinute && a.endMinute === b.endMinute;

// Classifies an accepted revision by comparing it with its recorded predecessor.
function changeLabel(previous: HistorySchedule, next: HistorySchedule) {
  const duration = (next.endMinute - next.startMinute) - (previous.endMinute - previous.startMinute);
  if (duration > 0) return "Extended";
  if (duration < 0) return "Reduced";
  if (!sameSchedule(previous, next)) return "Rescheduled";
  return next.total === previous.total ? "Booking details updated" : "Price updated";
}

export function buildBookingHistory(input: { status: BookingStatus; revisions: readonly HistoryRevision[];
  adjustments: readonly HistoryAdjustment[] }): BookingHistoryEvent[] {
  const revisions = [...input.revisions].sort((a, b) => a.revisionNumber - b.revisionNumber);
  const byId = new Map(revisions.map(revision => [revision.id, revision]));
  const adjustments = new Map(input.adjustments.map(adjustment => [adjustment.id, adjustment]));
  const events: BookingHistoryEvent[] = [];
  revisions.forEach((revision, index) => {
    const at = revision.recordedAt.toISOString(), actor = actors[revision.actorScope];
    const current = schedule(revision), prior = index > 0 ? schedule(revisions[index - 1]) : null;
    const request = revision.adjustmentId ? adjustments.get(revision.adjustmentId) : undefined;
    const base = { key: revision.id, at, recorded: true,
      requestedAt: request ? request.createdAt.toISOString() : null, status: stateStatus[revision.bookingState] };
    if (revision.kind === "created") events.push({ ...base, kind: "created", label: "Booking created", previous: null, next: current,
      detail: `Booked by ${actor} · ${revision.paymentMethod === "online" ? "Online payment" : "Pay at club"}` });
    else if (revision.kind === "confirmed") events.push({ ...base, kind: "confirmed", label: "Booking confirmed", previous: null, next: null,
      detail: revision.actorScope === "provider" ? "Confirmed by verified payment" : `Confirmed by ${actor}` });
    else if (revision.kind === "rescheduled") events.push({ ...base, kind: "change", label: prior ? changeLabel(prior, current) : "Rescheduled",
      previous: prior, next: current, detail: `Changed by ${actor}` });
    else events.push({ ...base, kind: "cancelled", label: "Cancelled", previous: null, next: current,
      detail: revision.cancellationCause ? cancellationCauses[revision.cancellationCause] : `Cancelled by ${actor}` });
  });
  // Applied requests are represented by their accepted revision above.
  for (const adjustment of input.adjustments) {
    if (adjustment.status === "applied") continue;
    const baseRevision = byId.get(adjustment.baseRevisionId);
    const target = adjustment.target;
    events.push({ key: adjustment.id, kind: "request", recorded: true, at: adjustment.createdAt.toISOString(), requestedAt: null,
      label: adjustment.kind === "cancellation" ? "Cancellation requested" : "Modification requested",
      detail: `Requested by ${adjustment.scope === "admin" ? "an administrator" : "the booking owner"} · not applied${
        adjustment.status === "pending" ? " yet" : ""}`,
      status: requestStatus[adjustment.status],
      previous: baseRevision ? schedule(baseRevision) : null,
      next: adjustment.kind === "cancellation" ? null : { courtId: target.courtId, locationName: target.locationName, courtName: target.courtName,
        timezone: target.timezone, date: target.date, startMinute: target.startMinute, endMinute: target.endMinute,
        total: adjustment.newTotal, currency: z.enum(locationCurrencies).parse(adjustment.currency) } });
  }
  // Same-instant ties keep revision order; change requests precede their outcome.
  const sequence = (event: BookingHistoryEvent) => byId.get(event.key)?.revisionNumber ?? 0;
  events.sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!) || sequence(a) - sequence(b));
  // Checkout expiry/failure updates only the booking status, without a revision or time.
  const last = revisions.at(-1);
  if (!last || last.bookingState !== input.status) events.push({ key: "current-status", kind: "status", recorded: false,
    at: null, requestedAt: null, label: inferredStatus[input.status], previous: null, next: null,
    detail: "Shown from the current booking status. No history record or time was stored for this change.",
    status: { label: bookingStatusLabels[input.status], tone: input.status === "failed" ? "danger" : "neutral" } });
  return events;
}

export const hasRecordedChanges = (events: readonly BookingHistoryEvent[]) =>
  events.some(event => event.kind === "change" || event.kind === "cancelled" || event.kind === "request");

type ReportedFinancials = ReturnType<typeof summarizeReportedFinancials>;

// Admin summary over the shared reporting read model: paid money is verified
// captures, refunded money is verified successful executions only.
export function summarizeBookingFinancials(input: { status: BookingStatus; total: number; currency: LocationCurrency;
  paymentMethod: "online" | "pay_at_club"; ended: boolean; financials: ReportedFinancials; outstanding: number }) {
  const { financials, currency } = input;
  const totals = financials.totals.find(total => total.currency === currency);
  const captured = new Set(financials.captures.map(capture => capture.paymentAttemptId));
  const sum = (values: { amount: number }[]) => values.reduce((total, value) => total + value.amount, 0);
  const refunds = financials.refunds.filter(refund => refund.currency === currency && !refund.verified);
  const atClub = input.paymentMethod === "pay_at_club";
  return {
    currency, total: input.total,
    paid: totals?.captured ?? 0, refunded: totals?.refunded ?? 0, net: totals?.netPaid ?? 0,
    // In-flight requests without a capture; cancelled, expired, failed and club-due attempts moved no money.
    pendingPayments: sum(financials.payments.filter(payment => payment.currency === currency && !captured.has(payment.id)
      && payment.status === "pending")),
    pendingRefunds: sum(refunds.filter(refund => refund.status !== "failed" && refund.status !== "voided")),
    failedRefunds: sum(refunds.filter(refund => refund.status === "failed")),
    outstanding: atClub ? 0 : input.outstanding,
    // Club collection is not recorded online, so it is never shown as received.
    dueAtClub: atClub && !input.ended ? input.outstanding : 0,
    unrecordedAtClub: atClub && input.ended ? input.outstanding : 0,
    activeBooking: input.status === "confirmed" || input.status === "pending_payment",
    otherCurrencies: financials.totals.filter(total => total.currency !== currency),
  };
}
export type AdminBookingFinancialSummary = ReturnType<typeof summarizeBookingFinancials>;
