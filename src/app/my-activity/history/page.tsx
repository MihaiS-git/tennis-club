import type { Metadata } from "next";
import type { ActivitySearchParams } from "@/lib/bookings/activity-query";
import { Suspense } from "react";
import { BookingHistoryContent } from "./content";

export const metadata: Metadata = { title: "Booking history | Tennis Club" };

export default function BookingHistoryPage({ searchParams }: { searchParams: Promise<ActivitySearchParams> }) {
  return <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading booking history…</p>}>
    <BookingHistoryContent searchParams={searchParams} />
  </Suspense>;
}
