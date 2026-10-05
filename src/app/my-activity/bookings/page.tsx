import type { Metadata } from "next";
import type { ActivitySearchParams } from "@/lib/bookings/activity-query";
import { Suspense } from "react";
import { MyBookingsContent } from "./content";

export const metadata: Metadata = { title: "Bookings & reservations | Tennis Club" };

export default function MyBookingsPage({ searchParams }: { searchParams: Promise<ActivitySearchParams> }) {
  return <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading bookings & reservations…</p>}>
    <MyBookingsContent searchParams={searchParams} />
  </Suspense>;
}
