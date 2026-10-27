import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LoadingStatus } from "@/components/loading-status";

type LegacyBookingHistoryProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function LegacyBookingHistoryPage({ searchParams }: LegacyBookingHistoryProps) {
  return <Suspense fallback={<LoadingStatus variant="page" label="Loading booking history…" />}>
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
