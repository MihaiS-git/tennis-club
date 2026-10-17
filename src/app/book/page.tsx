import type { Metadata } from "next";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { BookingContent } from "./booking-content";

export const metadata: Metadata = {
  title: "Book a court | Tennis Club",
  description: "Find available court time for your chosen day.",
};

export default function BookPage({ searchParams }: PageProps<"/book">) {
  return <main className="flex-1 px-4 pb-10 pt-6 sm:px-6 md:px-8 md:pt-8">
    <div className="mx-auto max-w-7xl">
      <p className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
        <span aria-hidden="true" className="h-0.5 w-8 bg-accent" />Court booking
      </p>
      <h1 className="mt-2 font-heading text-[clamp(32px,4vw,44px)] font-semibold leading-tight tracking-[-0.04em] text-primary">Find time on court.</h1>
      <section aria-label="Court availability">
        <Suspense fallback={<p role="status" className="mt-5 flex items-center gap-2 rounded-card border border-border bg-surface p-5 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />Loading court availability…
        </p>}>
          <BookingContent searchParams={searchParams} />
        </Suspense>
      </section>
    </div>
  </main>;
}
