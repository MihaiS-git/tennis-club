import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { profileContext } from "@/lib/profile/profile";
import { listOwnCourtHistory } from "@/lib/bookings/history-service";
import { HistoryActivity } from "./history-activity";

export const metadata: Metadata = { title: "Booking history | Tennis Club" };

export function parseHistoryPage(value: string | string[] | undefined) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= 1000000 ? page : 1;
}

export default function BookingHistoryPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  return <Suspense fallback={<main className="flex-1 px-6 py-8 md:px-8"><p role="status" className="mx-auto max-w-4xl text-sm text-muted-foreground">Loading booking history…</p></main>}>
    <BookingHistoryContent searchParams={searchParams} />
  </Suspense>;
}

export async function BookingHistoryContent({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const { client, account } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <main className="flex-1 px-6 py-12"><p className="mx-auto max-w-3xl text-muted-foreground">Your account cannot access activity right now.</p></main>;
  const page = parseHistoryPage((await searchParams).page);
  const history = await listOwnCourtHistory(page, client);

  return <main className="flex-1 px-6 py-8 md:px-8"><div className="mx-auto max-w-4xl">
    <Link href="/my-activity/bookings" className="text-sm font-semibold text-primary underline underline-offset-4">Bookings & reservations</Link>
    <h1 className="mt-4 font-heading text-3xl font-semibold text-primary">Booking history</h1>
    <p className="mt-2 text-sm text-muted-foreground">Previous and cancelled court activity.</p>
    <section aria-label="Booking history" className="mt-6 rounded-card border border-border bg-surface p-5">
      <HistoryActivity rows={history.rows} page={page} />
    </section>
    {(page > 1 || history.hasNext) && <nav aria-label="History pages" className="mt-5 flex items-center justify-between text-sm">
      {page > 1 ? <Link href={`/my-activity/bookings/history?page=${page - 1}`} className="font-semibold text-primary underline underline-offset-4">Previous</Link> : <span />}
      <span>Page {page}</span>
      {history.hasNext ? <Link href={`/my-activity/bookings/history?page=${page + 1}`} className="font-semibold text-primary underline underline-offset-4">Next</Link> : <span />}
    </nav>}
    {page > 1 && history.rows.length === 0 && <Link href="/my-activity/bookings/history?page=1" className="mt-4 inline-block text-sm font-semibold text-primary underline underline-offset-4">Return to first page</Link>}
  </div></main>;
}
