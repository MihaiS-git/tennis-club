import { redirect } from "next/navigation";
import { Suspense } from "react";

type LegacyBookingHistoryProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function LegacyBookingHistoryPage({ searchParams }: LegacyBookingHistoryProps) {
  return <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading booking history…</p>}>
    <LegacyBookingHistoryRedirect searchParams={searchParams} />
  </Suspense>;
}

async function LegacyBookingHistoryRedirect({ searchParams }: LegacyBookingHistoryProps) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") query.set(key, value);
  }
  return redirect(`/my-activity/history${query.size ? `?${query}` : ""}`);
}
