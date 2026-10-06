import { DetailSection } from "@/components/dialog-layout";
import { ReservationScheduleFieldsView } from "@/components/reservation-details";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import { customerCancellationNoticeLabel, customerMutationDeadline } from "@/lib/bookings/self-cancellation";
import { formatMoney } from "@/lib/pricing/money";

export function BookingDetails({ booking }: { booking: Omit<PersonalCustomerBooking, "id" | "starts_at_instant"> & { starts_at_instant?: string } }) {
  const cutoff = booking.starts_at_instant
    ? new Date(customerMutationDeadline({ ...booking, starts_at_instant: booking.starts_at_instant }, false).deadline) : null;
  return <>
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
