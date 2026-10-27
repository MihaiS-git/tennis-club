import type { Metadata } from "next";
import type { ActivitySearchParams } from "@/lib/bookings/activity-query";
import { Suspense } from "react";
import { MyBookingsContent } from "./content";
import { LoadingStatus } from "@/components/loading-status";

export const metadata: Metadata = { title: "Bookings & reservations | Tennis Club" };

export default function MyBookingsPage({ searchParams }: { searchParams: Promise<ActivitySearchParams> }) {
  return <Suspense fallback={<LoadingStatus variant="page" label="Loading bookings & reservations…" />}>
    <MyBookingsContent searchParams={searchParams} />
  </Suspense>;
}
