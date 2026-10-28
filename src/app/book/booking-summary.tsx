import { minuteToTime } from "@/lib/courts/local-time";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/currency";

export type BookingSummaryDetails = { locationName: string; courtName: string; date: string;
  startMinute: number; endMinute: number; durationMinutes: number;
  priceMinor: number; currency: LocationCurrency;
  coaching?: { participantCount: number; programName: string; coachName: string; coachingAmountMinor: number; courtAmountMinor: number; courtRentalIncluded: boolean } };

export function BookingSummary({ details }: { details: BookingSummaryDetails }) {
  const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${details.date}T00:00:00Z`));
  const items = [
    ["Location", details.locationName], ["Court", details.courtName], ["Date", dateLabel],
    ["Time", `${minuteToTime(details.startMinute)}–${minuteToTime(details.endMinute)}`],
    ["Duration", `${details.durationMinutes} min`],
    ...(details.coaching ? [["Program", details.coaching.programName],
      ["Participants", `${details.coaching.participantCount} ${details.coaching.participantCount === 1 ? "player" : "players"}`], ["Coach", details.coaching.coachName],
      ["Coaching price", formatMoney(details.coaching.coachingAmountMinor, details.currency)],
      ["Court rental", details.coaching.courtRentalIncluded ? "Included" : formatMoney(details.coaching.courtAmountMinor, details.currency)]] : []),
  ];
  return <div className="rounded-control border border-border bg-background"><dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
    {items.map(([label, value]) => <div key={label} className="contents">
      <dt className="font-medium text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums text-foreground">{value}</dd>
    </div>)}
  </dl><div className="flex items-baseline justify-between gap-3 border-t border-border px-4 py-3">
    <span className="text-sm font-semibold text-muted-foreground">Total</span>
    <strong className="font-heading text-2xl tabular-nums text-primary">{formatMoney(details.priceMinor, details.currency)}</strong>
  </div></div>;
}
