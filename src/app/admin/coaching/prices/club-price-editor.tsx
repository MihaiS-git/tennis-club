"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import type { AdminCoachingProgram } from "@/lib/coaching/admin";
import { coachingParticipantCounts, coachingParticipantRange, formatCoachingDuration, formatPlayers as players } from "@/lib/coaching/validation";
import { majorAmountSchema, minorToMajor, type LocationCurrency } from "@/lib/pricing/money";
import { saveClubCoachingPricesAction } from "../actions";
import { coachingFailureMessages } from "../coaching-form";

// Club lesson prices/person of one program duration in one currency, one independent row per
// player count in the program's range. An empty amount means not configured, never zero; a
// saved price is removed only through its explicit Remove action. Prices outside the range do
// not exist: saving the program removes them.
export function ClubPriceEditor({ program, currency, durationMinutes, prices, chargeable }: {
  program: Pick<AdminCoachingProgram, "id" | "name" | "min_participants" | "max_participants">;
  currency: LocationCurrency; durationMinutes: number;
  prices: readonly { participant_count: number; amount_minor: number }[];
  // Whether a current location charges in this currency; otherwise prices can only be removed.
  chargeable: boolean;
}) {
  const router = useRouter();
  const prefix = useId();
  const pendingRef = useRef(false);
  const range = coachingParticipantRange({ minParticipants: program.min_participants, maxParticipants: program.max_participants });
  const counts = chargeable ? coachingParticipantCounts(range) : [];
  const stored = new Map(prices.map((price) => [price.participant_count, price.amount_minor]));
  // Only prices in a currency no current location charges in remain, removable.
  const outside = prices.filter((price) => !counts.includes(price.participant_count));
  const subject = `club ${formatCoachingDuration(durationMinutes)} lesson price/person`;
  const [values, setValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(prices.map((price) => [price.participant_count, minorToMajor(price.amount_minor)])));
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const text = (count: number) => (values[count] ?? "").trim();
  function error(count: number) {
    if (removed.has(count)) return undefined;
    if (text(count) === "") return stored.has(count) ? "Enter a price, or use Remove to clear it." : undefined;
    return majorAmountSchema.safeParse(text(count)).success ? errors[count] : "Enter a positive amount with at most two decimal places.";
  }
  const saved = counts.flatMap((count) => {
    const amount = majorAmountSchema.safeParse(text(count));
    return !removed.has(count) && amount.success && amount.data !== stored.get(count) ? [{ participant_count: count, amount: text(count) }] : [];
  });
  const removals = [...removed].filter((count) => stored.has(count)).sort((a, b) => a - b);
  const valid = counts.every((count) => !error(count));
  const dirty = saved.length > 0 || removals.length > 0;

  function toggleRemoved(count: number) {
    setRemoved((current) => { const next = new Set(current); if (!next.delete(count)) next.add(count); return next; });
  }
  function reset() {
    setValues(Object.fromEntries(prices.map((price) => [price.participant_count, minorToMajor(price.amount_minor)])));
    setRemoved(new Set()); setErrors({}); setFormError(null);
  }

  async function submit() {
    if (pendingRef.current || !valid || !dirty) return;
    pendingRef.current = true; setPending(true); setFormError(null);
    const notification = toast.loading("Saving prices…");
    try {
      const result = await saveClubCoachingPricesAction({ program_id: program.id, currency, duration_minutes: durationMinutes, prices: saved, removed: removals });
      if (result.ok) {
        toast.success("Prices saved.", { id: notification });
        router.refresh();
      } else if (result.reason === "invalid-input") {
        toast.dismiss(notification);
        // Entry errors name their submitted index; show them beside that player count.
        const entries = Object.fromEntries(saved.flatMap((price, index) => {
          const message = result.fieldErrors[`prices.${index}`];
          return message ? [[price.participant_count, message]] : [];
        }));
        setErrors(entries);
        if (!Object.keys(entries).length) setFormError(Object.values(result.fieldErrors)[0] || "Check the prices.");
      } else {
        toast.dismiss(notification); setFormError(coachingFailureMessages[result.reason]);
      }
    } catch {
      toast.error("Unable to save the prices. Please try again.", { id: notification });
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }

  const removeButton = (count: number) => <Button type="button" variant="subtle" size="small" fullWidth={false} disabled={pending}
    onClick={() => toggleRemoved(count)} aria-label={`${removed.has(count) ? "Keep" : "Remove"} ${program.name} ${currency} ${subject}, ${players(count)}`}>
    {removed.has(count) ? "Undo" : "Remove"}
  </Button>;

  return <form className="min-w-0" aria-label={`${program.name} club prices in ${currency}`}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {!range ? <p className="text-sm text-muted-foreground">Set the program’s minimum and maximum players under Programs to configure these prices.</p>
      : !chargeable && <p className="text-sm text-muted-foreground">No current location charges in {currency}.</p>}
    {range && chargeable && program.min_participants !== program.max_participants && <p className="mb-1 text-xs text-muted-foreground">
      Lesson price/person for each number of players; each is set separately.</p>}
    {counts.length > 0 && <table className="text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr><th scope="col" className="pb-1 pr-3 text-left font-semibold">Players</th>
          <th scope="col" className="pb-1 text-left font-semibold">Lesson price/person</th></tr>
      </thead>
      <tbody>
        {counts.map((count) => {
          const id = `${prefix}-${count}`;
          const rowError = error(count);
          return <tr key={count} className="align-top">
            <td className="py-1 pr-3"><label htmlFor={id} className="inline-flex min-h-9 items-center">{count}
              <span className="sr-only"> {count === 1 ? "player" : "players"}, {program.name} {subject} in {currency}</span></label></td>
            <td className="py-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className={`flex min-h-9 w-32 items-center rounded-control border bg-surface pr-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-focus/20 ${rowError ? "border-danger" : "border-border"}`}>
                  <input id={id} value={removed.has(count) ? "" : values[count] ?? ""} inputMode="decimal"
                    placeholder={removed.has(count) ? "Removed" : "Not set"} disabled={pending || removed.has(count)}
                    onChange={(event) => { const value = event.target.value; setValues((current) => ({ ...current, [count]: value }));
                      setErrors((current) => ({ ...current, [count]: "" })); }}
                    aria-invalid={Boolean(rowError)} aria-describedby={rowError ? `${id}-error` : undefined}
                    className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none disabled:opacity-60" />
                  <span className="text-xs font-semibold text-muted-foreground">{currency}</span>
                </div>
                {stored.has(count) && removeButton(count)}
              </div>
              {removed.has(count) && <p className="mt-1 text-xs text-muted-foreground">Removed when you save.</p>}
              {rowError && <p id={`${id}-error`} className="mt-1 text-xs text-danger">{rowError}</p>}
            </td>
          </tr>;
        })}
      </tbody>
    </table>}
    {outside.length > 0 && <div className="mt-2">
      <p className="text-xs text-muted-foreground">Saved prices, not published:</p>
      <ul className="mt-1 space-y-1">
        {outside.map((price) => <li key={price.participant_count} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{players(price.participant_count)}: {minorToMajor(price.amount_minor)} {currency}</span>
          {removeButton(price.participant_count)}
          {removed.has(price.participant_count) && <span className="text-xs text-muted-foreground">Removed when you save.</span>}
        </li>)}
      </ul>
    </div>}
    {formError && <p role="alert" className="mt-1 text-sm text-danger">{formError}</p>}
    {(counts.length > 0 || outside.length > 0) && <div className="mt-2 flex gap-2">
      <Button type="submit" size="small" fullWidth={false} disabled={pending || !valid || !dirty} aria-busy={pending}>{pending ? "Saving…" : "Save prices"}</Button>
      {dirty && <Button type="button" variant="subtle" size="small" fullWidth={false} disabled={pending} onClick={reset}>Cancel</Button>}
    </div>}
  </form>;
}
