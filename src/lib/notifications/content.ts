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

export function bookingDetails(booking: BookingContext) {
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${booking.bookingDate}T12:00:00Z`));
  return [
    `Location: ${booking.locationName}`,
    `Court: ${booking.courtName}`,
    `Date: ${date}`,
    `Time: ${minute(booking.startMinute)}–${minute(booking.endMinute)} (${booking.timezone})`,
    ...(booking.coachingProgramName ? [`Program: ${booking.coachingProgramName}`] : []),
    ...(booking.coachName ? [`Coach: ${booking.coachName}`] : []),
  ];
}

export function bookingContent(revision: RevisionSnapshot, event: "confirmed" | "cancelled" | "rescheduled", refund?: string) {
  const lesson = revision.coachUserId != null;
  const subject = `${lesson ? "Coaching lesson" : "Court booking"} ${event}`;
  const opening = event === "confirmed" ? `Your ${lesson ? "coaching lesson" : "court booking"} is confirmed.`
    : event === "cancelled" ? `Your ${lesson ? "coaching lesson" : "court booking"} was cancelled.`
      : `Your ${lesson ? "coaching lesson" : "court booking"} was rescheduled. New booking details:`;
  const price = `${event === "rescheduled" ? "New total" : "Total price"}: ${formatMoney(revision.totalAmountMinor, revision.currency)}`;
  const bodyText = [opening, ...bookingDetails(revision), price, ...(refund ? [refund] : [])].join("\n");
  return { subject, bodyText, bodyHtml: plainHtml(bodyText) };
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
