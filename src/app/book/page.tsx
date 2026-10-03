import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingContent } from "./booking-content";

export const metadata: Metadata = {
  title: "Book a court | Tennis Club",
  description: "Find available court time for your chosen day.",
};

export default function BookPage({ searchParams }: PageProps<"/book">) {
  return <main className="flex-1 px-6 py-3 md:px-8">
    <div className="mx-auto max-w-7xl">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-accent">Court booking</p>
      <h1 className="font-heading text-[clamp(32px,4vw,44px)] font-semibold leading-tight tracking-[-0.04em] text-primary">Find time on court.</h1>
      <section aria-label="Court availability" className="mt-2">
        <Suspense fallback={<p role="status" className="text-muted-foreground">Loading court availability…</p>}>
          <BookingContent searchParams={searchParams} />
        </Suspense>
      </section>
    </div>
  </main>;
}
