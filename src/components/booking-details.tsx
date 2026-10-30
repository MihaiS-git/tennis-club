import { bookingType, bookingTypeLabel, type BookingTypeSnapshot } from "@/lib/bookings/booking-type";
import type { PricingEvidence } from "@/lib/bookings/revision";
import { DetailSection } from "@/components/dialog-layout";
import { ReservationScheduleFieldsView } from "@/components/reservation-details";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import { customerCancellationNoticeLabel, customerMutationDeadline } from "@/lib/bookings/self-cancellation";
import { formatMoney } from "@/lib/pricing/money";

type CoachingDetailsSnapshot = BookingTypeSnapshot & { coaching?: PricingEvidence["coaching"] | null };

export function CoachingBookingDetails({ booking, title = "Coaching details" }: { booking: CoachingDetailsSnapshot; title?: string }) {
  const coaching = bookingType(booking) === "coaching" ? booking.coaching : null;
  if (!coaching) return null;
  return <DetailSection title={title}>
    <dt className="text-muted-foreground">Coach</dt><dd>{booking.coach_name}</dd>
    <dt className="text-muted-foreground">Program</dt><dd>{booking.coaching_program_name}</dd>
    <dt className="text-muted-foreground">Participants</dt><dd>{coaching.participantCount}</dd>
    <dt className="text-muted-foreground">Lesson duration</dt><dd>{coaching.durationMinutes} min</dd>
    <dt className="text-muted-foreground">Coaching fee</dt><dd className="tabular-nums">{formatMoney(coaching.amountMinor, coaching.currency)}</dd>
    <dt className="text-muted-foreground">Court rental</dt><dd>{coaching.courtRentalIncluded ? "Included" : <>Charged separately · {formatMoney(coaching.courtAmountMinor, coaching.currency)}</>}</dd>
  </DetailSection>;
}

// noticeBypass: the viewer is an Admin or Coach owner, who may act until the booking starts.
export function BookingDetails({ booking, noticeBypass = false }: {
  booking: Omit<PersonalCustomerBooking, "id" | "starts_at_instant"> & CoachingDetailsSnapshot & { starts_at_instant?: string };
  noticeBypass?: boolean;
}) {
  const cutoff = booking.starts_at_instant
    ? new Date(customerMutationDeadline({ ...booking, starts_at_instant: booking.starts_at_instant }, noticeBypass).deadline) : null;
  return <>
    {bookingType(booking) === "coaching" && <DetailSection title="Booking type"><dt className="text-muted-foreground">Type</dt><dd>{bookingTypeLabel(booking)}</dd></DetailSection>}
    <CoachingBookingDetails booking={booking} />
    <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={booking} /></DetailSection>
    <DetailSection title="Customer contact">
      <dt className="text-muted-foreground">Name</dt><dd>{booking.customer_name}</dd>
      <dt className="text-muted-foreground">Email</dt><dd>{booking.customer_email}</dd>
      <dt className="text-muted-foreground">Phone</dt><dd>{booking.customer_phone}</dd>
    </DetailSection>
    <DetailSection title="Booking terms">
      <dt className="text-muted-foreground">Total</dt><dd className="text-lg font-semibold text-primary">{formatMoney(booking.total_amount_minor, booking.currency)}</dd>
      <dt className="text-muted-foreground">Cancellation</dt><dd>{customerCancellationNoticeLabel(booking.cancellation_notice_minutes)}</dd>
      {cutoff && <><dt className="text-muted-foreground">Deadline</dt><dd>{new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: booking.location_timezone }).format(cutoff)} ({booking.location_timezone})</dd></>}
    </DetailSection>
  </>;
}
