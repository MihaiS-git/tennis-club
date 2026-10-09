import type { Metadata } from "next";
import { Suspense } from "react";
import { ReservationContent } from "./reservation-content";

export const metadata: Metadata = { title: "Reservations | Tennis Club" };

export default function ReservationsPage({ searchParams }: { searchParams: Promise<{ location?: string; date?: string }> }) {
  return <main className="flex-1 px-6 py-3 md:px-8"><div className="mx-auto max-w-7xl">
    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-accent">Club operations</p>
    <h1 className="font-heading text-[clamp(32px,4vw,44px)] font-semibold leading-tight tracking-[-0.04em] text-primary">Reservations</h1>
    <Suspense fallback={<p role="status" className="mt-4 text-muted-foreground">Loading reservations…</p>}>
      <ReservationContent searchParams={searchParams} />
    </Suspense>
  </div></main>;
}
