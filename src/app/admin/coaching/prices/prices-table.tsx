import { SortableTableHeading, type TableSortLink } from "@/components/sortable-table-heading";
import type { PriceFilters } from "@/lib/coaching/admin-filters";
import type { AdminCoach, AdminCoachingCurrency, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";
import { formatCoachingDuration, isOnlineCoachingProgramType, formatPlayers } from "@/lib/coaching/validation";
import { formatMoney } from "@/lib/pricing/money";
import { ClubPriceEditor } from "./club-price-editor";

// Remount an editor when its stored prices or the program's range change, so entered values follow the server.
const editorKey = (prices: readonly { participant_count: number; amount_minor: number }[], program: AdminCoachingProgram) =>
  prices.map((price) => `${price.participant_count}:${price.amount_minor}`).join() + `|${program.min_participants}-${program.max_participants}`;

type Row = { program: AdminCoachingProgram; durationMinutes: number; currency: AdminCoachingCurrency };

// Club lesson prices/person are edited per player count. Individual coach prices belong to each coach and are read-only here.
export function PricesTable({ rows, coaches, prices, filters, filtered, sortLinks }: {
  rows: Row[]; coaches: AdminCoach[]; prices: AdminCoachingPrice[];
  filters: PriceFilters; filtered: boolean; sortLinks: Record<string, TableSortLink>;
}) {
  if (!rows.length) return <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
    {filtered ? "No coaching prices match these filters." : "No coaching programs yet. Create a program with at least one duration under Programs, then set its prices here."}
  </p>;
  const coachName = new Map(coaches.map((coach) => [coach.user_id, coach.display_name]));
  return <div className="overflow-x-auto rounded-card border border-border bg-surface">
    <table className="w-full min-w-[44rem] text-left font-sans text-sm" aria-label="Coaching prices">
      <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
        <tr>
          <SortableTableHeading label="Program" sort={sortLinks.program} />
          <SortableTableHeading label="Currency" sort={sortLinks.currency} />
          <SortableTableHeading label="Duration" sort={sortLinks.duration} />
          <SortableTableHeading label="Club lesson price/person by players" sort={sortLinks.amount} />
          <th scope="col" className="px-4 py-2.5">Individual coach prices</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => {
          const { currency } = row.currency;
          const { durationMinutes } = row;
          const online = isOnlineCoachingProgramType(row.program.program_type);
          const search = filters.search?.toLowerCase();
          const programMatches = !search || row.program.name.toLowerCase().includes(search);
          const showClub = filters.scope !== "coach" && !filters.coach && programMatches;
          const matching = prices.filter((price) => price.currency === currency && price.program_id === row.program.id && price.duration_minutes === durationMinutes);
          const offering = coaches.filter((coach) => online && coach.program_ids.includes(row.program.id)
            && (!filters.coach || coach.user_id === filters.coach)
            && (programMatches || (search && `${coach.display_name} ${coach.email}`.toLowerCase().includes(search))));
          const overrides = matching.filter((price) => price.coach_user_id !== null && offering.some(coach => coach.user_id === price.coach_user_id));
          const club = matching.filter((price) => price.coach_user_id === null);
          return <tr key={`${currency}-${row.program.id}-${durationMinutes}`} className="align-top">
            <td className="px-4 py-3">
              <p className="font-semibold text-foreground">{row.program.name}</p>
              <p className="text-xs text-muted-foreground">
                {online ? `Court rental ${row.program.court_rental_included ? "included" : "not included"}` : "Organized by the coach or club · Paid at the club"}
                {row.program.is_active ? "" : " · Inactive"}
              </p>
            </td>
            <td className="px-4 py-3">
              <p className="font-semibold text-foreground">{currency}</p>
              <p className="text-xs text-muted-foreground">{row.currency.location_names.length ? row.currency.location_names.join(", ") : "No current location"}</p>
            </td>
            <td className="whitespace-nowrap px-4 py-3">{formatCoachingDuration(durationMinutes)}<p className="text-xs text-muted-foreground">Lesson price/person</p></td>
            <td className="px-4 py-3">
              {showClub ? <ClubPriceEditor key={editorKey(club, row.program)} program={row.program} currency={currency} durationMinutes={durationMinutes}
                chargeable={row.currency.location_names.length > 0} prices={club} /> : "—"}
            </td>
            <td className="px-4 py-3">
              {!online ? <span className="text-muted-foreground">Club prices only</span>
                : filters.scope !== "club" && (overrides.length > 0 ? <ul className="space-y-0.5 text-sm">
                {overrides.map((price) => <li key={price.id}>
                  {coachName.get(price.coach_user_id ?? "") ?? "Coach"}, {formatPlayers(price.participant_count)}: {formatMoney(price.amount_minor, price.currency)} /person
                </li>)}
              </ul> : <span className="text-muted-foreground">—</span>)}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
