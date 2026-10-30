import type { OperationalFinancialQuote } from "@/lib/bookings/operational-policy";
import type { RevisionSnapshot } from "@/lib/bookings/revision";
import { formatMoney } from "@/lib/pricing/money";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function plainHtml(body: string) {
  return `<p>${body.split("\n").map(escapeHtml).join("<br>")}</p>`;
}

function minute(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export type BookingContext = Pick<RevisionSnapshot, "locationName" | "courtName" | "bookingDate" |
  "startMinute" | "endMinute" | "timezone" | "coachingProgramName" | "coachName">;

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T12:00:00Z`));
}

function timeLabel(booking: Pick<BookingContext, "startMinute" | "endMinute" | "timezone">) {
  return `${minute(booking.startMinute)}–${minute(booking.endMinute)} (${booking.timezone})`;
}

export function bookingDetails(booking: BookingContext) {
  return [
    `Location: ${booking.locationName}`,
    `Court: ${booking.courtName}`,
    `Date: ${dateLabel(booking.bookingDate)}`,
    `Time: ${timeLabel(booking)}`,
    ...(booking.coachingProgramName ? [`Program: ${booking.coachingProgramName}`] : []),
    ...(booking.coachName ? [`Coach: ${booking.coachName}`] : []),
  ];
}

// The schedule and total a reschedule replaced; coachUserId names the coach it was assigned to.
export type PreviousBooking = BookingContext & Pick<RevisionSnapshot, "totalAmountMinor"> & Partial<Pick<RevisionSnapshot, "coachUserId">>;

// note: one closing line on the transition's financial outcome (a completed refund, an
// absorbed price difference or a reduced amount due).
export function bookingContent(revision: RevisionSnapshot, event: "confirmed" | "cancelled" | "rescheduled", note?: string,
  previous?: PreviousBooking) {
  const lesson = revision.coachUserId != null;
  const subject = `${lesson ? "Coaching lesson" : "Court booking"} ${event}`;
  const opening = event === "confirmed" ? `Your ${lesson ? "coaching lesson" : "court booking"} is confirmed.`
    : event === "cancelled" ? `Your ${lesson ? "coaching lesson" : "court booking"} was cancelled.`
      : `Your ${lesson ? "coaching lesson" : "court booking"} was rescheduled. New booking details:`;
  const label = event !== "rescheduled" ? "Total price"
    : previous?.totalAmountMinor === revision.totalAmountMinor ? "Total price (unchanged)" : "New total";
  const price = `${label}: ${formatMoney(revision.totalAmountMinor, revision.currency)}`;
  const bodyText = [opening, ...bookingDetails(revision), ...replacedSchedule(event, previous), price, ...(note ? [note] : [])].join("\n");
  return { subject, bodyText, bodyHtml: plainHtml(bodyText) };
}

function replacedSchedule(event: "confirmed" | "cancelled" | "rescheduled", previous?: BookingContext) {
  return event === "rescheduled" && previous
    ? [`Previous date: ${dateLabel(previous.bookingDate)}`, `Previous time: ${timeLabel(previous)}`] : [];
}

// A lesson transition told in-app to its assigned coach: the operational lesson details and,
// for a reschedule, the replaced date and time. The customer's price, payments, refunds and
// financial outcome are never included.
export function coachLessonContent(revision: BookingContext, event: "confirmed" | "cancelled" | "rescheduled",
  previous?: BookingContext) {
  const opening = event === "confirmed" ? "Your assigned coaching lesson is confirmed."
    : event === "cancelled" ? "Your assigned coaching lesson was cancelled."
      : "Your assigned coaching lesson was rescheduled. New booking details:";
  const bodyText = [opening, ...bookingDetails(revision), ...replacedSchedule(event, previous)].join("\n");
  return { subject: `Coaching lesson ${event}`, bodyText };
}

// The customer-facing outcome of a staff change, from its accepted financial quote. A refund
// is announced as completed only by the verified transition (refundCompleted).
export function operationalFinancialNote(quote: OperationalFinancialQuote, paymentMethod: RevisionSnapshot["paymentMethod"]) {
  const money = (amount: number) => formatMoney(amount, quote.currency);
  if (quote.consequence === "club_absorbs") return `This booking time is priced at ${money(quote.destinationAmountMinor)}. `
    + `The club covers the difference of ${money(quote.absorbedMinor)}; no additional payment is required.`;
  if (quote.consequence === "amount_reduced") return paymentMethod === "pay_at_club"
    ? `The amount due at the club is reduced from ${money(quote.currentAmountMinor)} to ${money(quote.customerAmountMinor)}.`
    : `The booking price is reduced from ${money(quote.currentAmountMinor)} to ${money(quote.customerAmountMinor)}.`;
  return undefined;
}

// A completed coach reassignment, told to each coach in-app: the replacement coach learns of
// the lesson now assigned to them, the previous coach of the lesson they no longer teach. No
// prices, payments or refunds are included; the recipient is the coach named, so it is omitted.
export function coachReassignmentContent(lesson: BookingContext, role: "assigned" | "unassigned") {
  const bodyText = [role === "assigned" ? "A coaching lesson is now assigned to you. Lesson details:"
    : "This coaching lesson is no longer assigned to you. Previous lesson details:",
  ...bookingDetails({ ...lesson, coachName: null })].join("\n");
  return { subject: role === "assigned" ? "Coaching lesson assigned to you" : "Coaching lesson reassigned", bodyText };
}

export function refundCompletedNote(amountMinor: number, currency: RevisionSnapshot["currency"]) {
  return `The price reduction refund of ${formatMoney(amountMinor, currency)} completed.`;
}

// A staff change that lowers the price waits for its refund: the customer learns of the
// proposed booking and the requested refund, and that the current booking stays in place.
export function changeRefundRequestedContent(current: BookingContext, proposed: BookingContext, input: {
  lesson: boolean; refundMinor: number; newTotalMinor: number; currency: RevisionSnapshot["currency"] }) {
  const kind = input.lesson ? "coaching lesson" : "court booking";
  const bodyText = [`The club is rescheduling your ${kind} at a lower price. `
    + `A refund of ${formatMoney(input.refundMinor, input.currency)} has been requested.`,
  "The change is applied once the refund is confirmed. Until then your current booking remains in place.",
  "Proposed booking details:", ...bookingDetails(proposed),
  `Current date: ${dateLabel(current.bookingDate)}`, `Current time: ${timeLabel(current)}`,
  `New total: ${formatMoney(input.newTotalMinor, input.currency)}`].join("\n");
  return { subject: `${input.lesson ? "Coaching lesson" : "Court booking"} change awaiting refund`, bodyText, bodyHtml: plainHtml(bodyText) };
}

export type FinancialContent = {
  kind: string; booking: BookingContext; amountMinor: number | null; currency: RevisionSnapshot["currency"];
};

const explanations: Record<string, { subject: string; customer: string; admin: string }> = {
  cancellation_rejected: { subject: "Booking cancellation payment issue",
    customer: "The cancellation could not be completed. Your booking remains in place.",
    admin: "The cancellation could not be completed. Review the payment and booking before contacting the customer." },
  modification_rejected: { subject: "Booking change payment issue",
    customer: "The requested change could not be completed. Your original booking remains in place.",
    admin: "The requested change could not be completed. Review the payment and original booking." },
  refunded_modification_unapplied: { subject: "Booking change needs review",
    customer: "A refund completed, but the requested change could not be applied. Your original booking remains in place.",
    admin: "A refund completed, but the requested change was not applied. Review the booking and refund, then contact the customer." },
  surcharge_unapplied: { subject: "Booking change needs review",
    customer: "An additional payment was captured, but the requested change could not be applied. A compensation refund was requested; its outcome is not yet confirmed.",
    admin: "An additional payment was captured, but the change was not applied. Check the compensation refund outcome and contact the customer." },
  late_capture: { subject: "Booking payment needs review",
    customer: "A payment was captured after the booking hold ended. A compensation refund was requested; its outcome is not yet confirmed.",
    admin: "A payment was captured after the booking hold ended. Check the compensation refund outcome and contact the customer." },
  refund_failed: { subject: "Booking refund failed",
    customer: "The refund failed. The club needs to review the payment.",
    admin: "The refund failed. Review the payment provider result and resolve the customer refund." },
  refund_unresolved: { subject: "Booking refund outcome needs review",
    customer: "The refund outcome is unresolved.",
    admin: "The refund outcome is unresolved. Check the provider before retrying or reporting a result to the customer." },
  refund_reversed: { subject: "Booking refund reversed",
    customer: "A previously successful refund was reversed by the payment provider. The club needs to review it.",
    admin: "A previously successful refund was reversed. Review the provider record and resolve the customer balance." },
};

export function financialContent(fact: FinancialContent, audience: "customer" | "admin") {
  const explanation = explanations[fact.kind] ?? { subject: "Booking payment needs review",
    customer: "The club is reviewing a payment issue with your booking.",
    admin: "Review the payment and booking, then contact the customer." };
  const bodyText = [explanation[audience], ...bookingDetails(fact.booking),
    ...(fact.amountMinor === null ? [] : [`Amount involved: ${formatMoney(fact.amountMinor, fact.currency)}`])].join("\n");
  return { subject: explanation.subject, bodyText, bodyHtml: plainHtml(bodyText) };
}
