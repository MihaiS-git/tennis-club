"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { AdminLocation } from "@/lib/admin/locations";
import { weekdays, minuteToTime } from "@/lib/admin/opening-hours-validation";
import { courtStateLabels, type PricingRuleSet, type PricingMutationResult } from "@/lib/pricing/validation";
import { formatHourlyPrice } from "@/lib/pricing/money";
import { formatWeekdays } from "@/lib/pricing/resolution";
import { PricingRuleForm, pricingButtonClass, type PricingCourt } from "./pricing-rule-form";
import { savePricingRuleAction, removePricingRuleAction } from "./actions";

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}
function validity(rule: PricingRuleSet) {
  if (rule.starts_on && rule.ends_on) return `${displayDate(rule.starts_on)} – ${displayDate(rule.ends_on)}`;
  if (rule.starts_on) return `From ${displayDate(rule.starts_on)}`;
  if (rule.ends_on) return `Until ${displayDate(rule.ends_on)}`;
  return "All dates";
}

export function PricingRules({ location, courts, rules }: {
  location: Pick<AdminLocation, "id" | "name" | "currency" | "timezone">; courts: PricingCourt[]; rules: PricingRuleSet[];
}) {
  const prefix = useId();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ rule?: PricingRuleSet } | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  async function mutate(operation: () => Promise<PricingMutationResult>) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(""); setFieldErrors({});
    try {
      const result = await operation();
      if (result.ok) { setEditing(null); toast.success("Pricing updated."); }
      else if (result.reason === "invalid-input") { setError("Check the pricing rule."); setFieldErrors(result.fieldErrors); }
      else setError(result.reason === "overlap"
        ? "This rule overlaps an existing rule for the same court, state, weekday, dates and time."
        : "This location or pricing rule no longer exists.");
    } catch { setError("Unable to change pricing. Please try again."); }
    finally { pendingRef.current = false; setPending(false); }
  }
  function begin(rule?: PricingRuleSet) { setEditing({ rule }); setError(""); setFieldErrors({}); }
  return <section aria-labelledby={`${prefix}-heading`}>
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div><h2 id={`${prefix}-heading`} className="font-heading text-2xl font-semibold">{location.name}</h2>
        <p className="mt-2 text-sm text-muted-foreground">Currency: {location.currency} · Times: {location.timezone}</p>
        <p className="mt-1 text-sm text-muted-foreground">Pricing must fit within configured opening hours.</p>
      </div>
      <button type="button" className={pricingButtonClass} disabled={pending || courts.length === 0} onClick={() => begin()}>Add rule</button>
    </div>
    {error && <p role="alert" className="mb-4 text-danger">{error}</p>}
    {editing && <PricingRuleForm key={editing.rule?.rule_set_id ?? "new"} location={location} courts={courts} rule={editing.rule}
      pending={pending} fieldErrors={fieldErrors} onSave={(input) => void mutate(() => savePricingRuleAction(input))}
      onCancel={() => { setEditing(null); setError(""); setFieldErrors({}); }} />}
    {rules.length === 0 ? <p className="rounded-card border border-border bg-surface p-6 text-muted-foreground">No pricing rules configured.</p>
      : <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="bg-surface-muted text-muted-foreground"><tr>
            <th scope="col" className="px-3 py-3">Courts</th><th scope="col" className="px-3 py-3">State</th>
            <th scope="col" className="px-3 py-3">Days</th><th scope="col" className="px-3 py-3">Time</th>
            <th scope="col" className="px-3 py-3">Validity</th><th scope="col" className="px-3 py-3">Price/hour</th>
            <th scope="col" className="px-3 py-3">Actions</th>
          </tr></thead>
          <tbody>{rules.map((item) => <tr key={item.rule_set_id} className="border-t border-border align-top">
            <td className="px-3 py-3 font-medium">{courts.filter((court) => item.court_ids.includes(court.id)).map((court) => court.name).join(", ")}</td>
            <td className="px-3 py-3">{courtStateLabels[item.court_state]}</td>
            <td className="px-3 py-3">{formatWeekdays(item.weekdays)}</td>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{minuteToTime(item.starts_at_minute)}–{minuteToTime(item.ends_at_minute)}</td>
            <td className="px-3 py-3">{validity(item)}</td>
            <td className="whitespace-nowrap px-3 py-3 font-semibold">{formatHourlyPrice(item.price_per_hour_minor, location.currency)}</td>
            <td className="px-3 py-2"><div className="flex gap-1">
              <button type="button" className={pricingButtonClass} disabled={pending} onClick={() => begin(item)}>Edit</button>
              <button type="button" className={pricingButtonClass} disabled={pending}
                onClick={() => void mutate(() => removePricingRuleAction({ rule_set_id: item.rule_set_id, location_id: location.id }))}>Remove</button>
            </div></td>
          </tr>)}</tbody>
        </table>
        <p className="sr-only">Times include their start and exclude their end. {weekdays[0]} starts the week.</p>
      </div>}
  </section>;
}
