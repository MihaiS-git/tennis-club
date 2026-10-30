import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { CoachingBookingDetails } from "@/components/booking-details";
import { DetailSection } from "@/components/dialog-layout";
import { ReservationScheduleFieldsView } from "@/components/reservation-details";
import { StatusBadge } from "@/components/status-badge";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { getAdminBookingRecords } from "@/lib/bookings/admin-details";
import { adminBookingHistoryHref, adminBookingsHref, adminBookingTransactionHref, bookingCreatedLabel, bookingStatusLabels, bookingStatusTones, parseAdminBookingQuery,
  parseAdminBookingReturn, parseFinancialHistoryPage } from "@/lib/bookings/admin-query";
import { bookingTypeLabel } from "@/lib/bookings/booking-type";
import { paymentMethodLabels } from "@/lib/payments/admin-query";
import { formatMoney } from "@/lib/pricing/money";
import { BookingActions } from "./booking-actions";
import { BookingHistory } from "./booking-history";
import { FinancialHistory, FinancialSummary } from "./booking-financials";
import { CopyBookingId } from "./copy-booking-id";

export const metadata: Metadata = { title: "Booking details | Tennis Club" };
export const instant = false;

export default async function AdminBookingPage({ params, searchParams }: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveAdmin();
  const id = z.uuid().safeParse((await params).bookingId);
  if (!id.success) notFound();
  const search = await searchParams;
  const records = await getAdminBookingRecords(id.data, { historyPage: parseFinancialHistoryPage(search) });
  if (!records) notFound();
  const { booking } = records;
  const query = parseAdminBookingQuery(search);
  // Opened from Transactions: return to that exact view instead.
  const returnLink = parseAdminBookingReturn(search);
  const back = returnLink ?? { href: adminBookingsHref(query), label: "Back to Bookings" };
  return <>
    <Link href={back.href} className="mb-4 inline-flex items-center gap-1.5 rounded-control text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
      <ArrowLeft size={16} aria-hidden />{back.label}
    </Link>
    <AdminPageHeader title={`Booking #${booking.id.slice(0, 8)}`} description={<>
      Created {bookingCreatedLabel(booking.created_at, booking.location_timezone)} ({booking.location_timezone})
    </>}>
      <StatusBadge tone={bookingStatusTones[booking.status]}>{bookingStatusLabels[booking.status]}</StatusBadge>
    </AdminPageHeader>
    <BookingActions booking={{ id: booking.id, coach_name: booking.coach_name, customer_name: booking.customer_name, location_name: booking.location_name,
      court_name: booking.court_name, booking_date: booking.booking_date, starts_at_minute: booking.starts_at_minute,
      ends_at_minute: booking.ends_at_minute, total_amount_minor: booking.total_amount_minor, currency: booking.currency }} availability={records.cancellation.availability}
      startsAt={records.cancellation.startsAt} refundAvailable={records.cancellation.refundAvailable} />
    <div className="grid max-w-4xl gap-x-8 rounded-card border border-border bg-surface p-5 pt-1 md:grid-cols-2">
      <DetailSection title="Booking identity">
        <dt className="text-muted-foreground">Booking type</dt><dd>{bookingTypeLabel(booking)}</dd>
        <dt className="text-muted-foreground">Booking ID</dt>
        <dd className="flex flex-wrap items-center gap-2"><code className="font-mono text-xs [overflow-wrap:anywhere]">{booking.id}</code>
          <CopyBookingId id={booking.id} /></dd>
        <dt className="text-muted-foreground">Status</dt><dd>{bookingStatusLabels[booking.status]}</dd>
        <dt className="text-muted-foreground">Created</dt><dd>{bookingCreatedLabel(booking.created_at, booking.location_timezone)}</dd>
      </DetailSection>
      <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={booking} /></DetailSection>
      <CoachingBookingDetails booking={booking} title="Coaching" />
      <DetailSection title="Booking terms">
        <dt className="text-muted-foreground">Total</dt>
        <dd className="font-semibold text-primary tabular-nums">{formatMoney(booking.total_amount_minor, booking.currency)}</dd>
        <dt className="text-muted-foreground">Currency</dt><dd>{booking.currency}</dd>
        <dt className="text-muted-foreground">Payment method</dt><dd>{paymentMethodLabels[booking.payment_method]}</dd>
      </DetailSection>
      <DetailSection title="Customer">
        <dt className="text-muted-foreground">Type</dt><dd>{booking.account_user_id ? "Account customer" : "Guest"}</dd>
        <dt className="text-muted-foreground">Name</dt><dd>{booking.customer_name}</dd>
        <dt className="text-muted-foreground">Email</dt><dd>{booking.customer_email}</dd>
        <dt className="text-muted-foreground">Phone</dt><dd>{booking.customer_phone}</dd>
        {booking.account_user_id && <><dt className="text-muted-foreground">Account</dt>
          <dd><Link href={`/admin/users/${booking.account_user_id}`} className="text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View user account</Link></dd></>}
      </DetailSection>
    </div>
    <div className="mt-6 grid max-w-4xl gap-6">
      <BookingHistory events={records.history} timezone={booking.location_timezone} />
      <FinancialSummary summary={records.summary} />
      <FinancialHistory operations={records.operations} timezone={booking.location_timezone}
        pageHref={(page) => adminBookingHistoryHref(booking.id, query, page, returnLink?.href)}
        transactionHref={(kind, transactionId) => adminBookingTransactionHref(kind, transactionId, booking.id, query,
          records.operations.page, returnLink?.href)} />
    </div>
  </>;
}
