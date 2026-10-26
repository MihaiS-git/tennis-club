import { PriceEditor } from "@/app/admin/coaching/prices/price-editor";
import type { CoachPricingView } from "@/lib/coaching/coach-pricing";
import { formatCoachingDuration, formatPlayers } from "@/lib/coaching/validation";
import { formatMoney } from "@/lib/pricing/money";
import { removeOwnCoachingPriceAction, saveOwnCoachingPriceAction } from "./actions";

const ownActions = { save: saveOwnCoachingPriceAction, remove: removeOwnCoachingPriceAction };

// The coach edits only their own lesson price/person inline, separately for each duration and number of
// players; the club price is shown for reference.
export function CoachPricingTable({ view }: { view: CoachPricingView }) {
  const locationNames = new Map(view.currencies.map((item) => [item.currency, item.location_names]));
  return <div className="overflow-x-auto rounded-card border border-border bg-surface">
    <table className="w-full min-w-[44rem] text-left font-sans text-sm" aria-label="My coaching prices">
      <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
        <tr>
          <th scope="col" className="px-4 py-2.5">Program</th>
          <th scope="col" className="px-4 py-2.5">Duration</th>
          <th scope="col" className="px-4 py-2.5">Players</th>
          <th scope="col" className="px-4 py-2.5">Currency</th>
          <th scope="col" className="px-4 py-2.5">Club price</th>
          <th scope="col" className="px-4 py-2.5">My price</th>
          <th scope="col" className="px-4 py-2.5">Booking price</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {view.rows.map((row) => {
          const label = `${row.program_name}, ${formatCoachingDuration(row.duration_minutes)}, ${formatPlayers(row.participant_count)}, ${row.currency}`;
          const locations = locationNames.get(row.currency) ?? [];
          return <tr key={`${row.program_id}-${row.duration_minutes}-${row.participant_count}-${row.currency}`} className="align-top">
            <td className="px-4 py-3">
              <p className="font-semibold text-foreground">{row.program_name}</p>
              <p className="text-xs text-muted-foreground">Lesson price/person</p>
              {!row.program_active && <p className="text-xs text-muted-foreground">Inactive</p>}
            </td>
            <td className="whitespace-nowrap px-4 py-3">{formatCoachingDuration(row.duration_minutes)}</td>
            <td className="whitespace-nowrap px-4 py-3">{formatPlayers(row.participant_count)}</td>
            <td className="px-4 py-3">
              <p className="font-semibold text-foreground">{row.currency}</p>
              <p className="text-xs text-muted-foreground">{locations.length ? locations.join(", ") : "No active location"}</p>
            </td>
            <td className="whitespace-nowrap px-4 py-3">
              {row.club_amount_minor === null ? <span className="text-muted-foreground">Not set</span> : formatMoney(row.club_amount_minor, row.currency)}
            </td>
            <td className="px-4 py-3">
              <PriceEditor label={`My lesson price/person for ${label}`} emptyHint={row.club_amount_minor === null ? "Not set" : "Club price"}
                target={{ program_id: row.program_id, duration_minutes: row.duration_minutes, participant_count: row.participant_count, currency: row.currency }}
                price={row.coach_amount_minor === null ? undefined : { amount_minor: row.coach_amount_minor }}
                actions={ownActions} confirmRemoval={false} />
            </td>
            <td className="whitespace-nowrap px-4 py-3">
              {row.effective ? <>
                <p className="font-semibold text-foreground">{formatMoney(row.effective.amountMinor, row.effective.currency)}</p>
                <p className="text-xs text-muted-foreground">{row.effective.source === "coach" ? "My price" : "Club price"}</p>
              </> : <span className="text-muted-foreground">Not configured</span>}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
