import type { Metadata } from "next";
import type { ActivitySearchParams } from "@/lib/bookings/activity-query";
import { Suspense } from "react";
import { BookingHistoryContent } from "./content";
import { LoadingStatus } from "@/components/loading-status";

export const metadata: Metadata = { title: "Booking history | Tennis Club" };

export default function BookingHistoryPage({ searchParams }: { searchParams: Promise<ActivitySearchParams> }) {
  return <Suspense fallback={<LoadingStatus variant="page" label="Loading booking history…" />}>
    <BookingHistoryContent searchParams={searchParams} />
  </Suspense>;
}
