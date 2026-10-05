import type { PersonalCustomerBooking } from "./personal";

export function customerCancellationEligibility(
  booking: Pick<PersonalCustomerBooking, "starts_at_instant" | "cancellation_notice_minutes">,
  staff: boolean, now = new Date(),
): "eligible" | "started" | "notice_required" {
  const start = Date.parse(booking.starts_at_instant);
  if (now.getTime() >= start) return "started";
  return staff || now.getTime() <= start - booking.cancellation_notice_minutes * 60_000
    ? "eligible" : "notice_required";
}

export function customerCancellationNoticeLabel(minutes: number) {
  if (minutes === 0) return "cancellation before booking start";
  if (minutes === 1) return "1 minute's notice";
  if (minutes === 60) return "1 hour's notice";
  return minutes % 60 === 0 ? `${minutes / 60} hours' notice` : `${minutes} minutes' notice`;
}
