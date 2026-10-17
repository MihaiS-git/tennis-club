import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { ReservationContent } from "./reservation-content";

export const metadata: Metadata = { title: "Reservations | Tennis Club" };

export default function ReservationsPage({ searchParams }: { searchParams: Promise<{ location?: string; date?: string }> }) {
  return <div>
    <AdminPageHeader title="Reservations" description="Reserve courts and review the day’s bookings by location." />
    <Suspense fallback={<p role="status" className="mt-4 text-muted-foreground">Loading reservations…</p>}>
      <ReservationContent searchParams={searchParams} />
    </Suspense>
  </div>;
}
