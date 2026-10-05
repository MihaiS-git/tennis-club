import { customerCancellationNoticeLabel } from "@/lib/bookings/self-cancellation";

export function BookingCancellationTerms({ noticeMinutes, cutoff, timezone }: {
  noticeMinutes: number; cutoff?: string | null; timezone: string;
}) {
  return <section aria-label="Cancellation terms" className="mt-4 rounded-control border border-border p-3 text-sm">
    <h3 className="font-semibold text-primary">Cancellation terms</h3>
    <p className="mt-1 text-muted-foreground">This booking requires {customerCancellationNoticeLabel(noticeMinutes)}.</p>
    {cutoff && <p className="mt-1 text-foreground">Cancellation deadline: {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(cutoff))} ({timezone})</p>}
  </section>;
}
