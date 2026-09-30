"use client";

import { useId, useState } from "react";
import { Input } from "@/components/input";
import type { AdminLocation } from "@/lib/admin/locations";
import type { AdminCourt } from "@/lib/admin/courts";
import { courtSurfaceLabels, courtEnvironmentLabels } from "@/lib/admin/courts-validation";
import { weekdays, minuteToTime } from "@/lib/admin/opening-hours-validation";
import { courtStates, courtStateLabels, type PricingRuleSet } from "@/lib/pricing/validation";
import { minorToMajor } from "@/lib/pricing/money";

export const pricingButtonClass = "rounded-control border border-border-strong px-3 py-2 text-sm font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60";
export type PricingCourt = Pick<AdminCourt, "id" | "location_id" | "name" | "surface" | "environment">;

export function PricingRuleForm({ location, courts, rule, pending, fieldErrors, onSave, onCancel, onRemove }: {
  location: Pick<AdminLocation, "id" | "currency">; courts: PricingCourt[]; rule?: PricingRuleSet;
  pending: boolean; fieldErrors: Record<string, string>; onSave: (input: unknown) => void; onCancel: () => void;
  onRemove?: () => void;
}) {
  const prefix = useId();
  const [selectedDays, setSelectedDays] = useState(rule?.weekdays ?? [0]);
  const [selectedCourts, setSelectedCourts] = useState(rule?.court_ids ?? []);
  const [state, setState] = useState(rule?.court_state ?? "outdoor");
  const incompatible = courts.filter((court) => selectedCourts.includes(court.id))
    .some((court) => (court.environment === "indoor") !== (state === "indoor"));
  const stateError = fieldErrors.court_state ?? (incompatible
    ? "Selected courts must share a valid state: indoor courts use Indoor; outdoor courts use Outdoor or Covered." : "");
  return <form aria-label="Pricing rule"
    onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      onSave({ ...(rule ? { rule_set_id: rule.rule_set_id } : {}), location_id: location.id,
        court_ids: selectedCourts, court_state: state, weekdays: selectedDays,
        starts_at: data.get("starts_at"), ends_at: data.get("ends_at"), starts_on: data.get("starts_on"), ends_on: data.get("ends_on"),
        price_per_hour: data.get("price_per_hour"),
      });
    }}>
    <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
      <fieldset className="sm:col-span-2" aria-invalid={Boolean(fieldErrors.court_ids)} aria-describedby={`${prefix}-courts-error`}>
        <legend className="mb-2 text-sm font-medium">Courts</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {courts.map((court) => <label key={court.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="court_ids" value={court.id} checked={selectedCourts.includes(court.id)}
              onChange={(event) => setSelectedCourts(event.target.checked ? [...selectedCourts, court.id] : selectedCourts.filter((id) => id !== court.id))} />
            {court.name} — {courtSurfaceLabels[court.surface]} · {courtEnvironmentLabels[court.environment]}
          </label>)}
        </div>
        {!courts.length && <p>No courts at this location. Create a court first.</p>}
        <p id={`${prefix}-courts-error`} className="mt-1 text-sm text-danger">{fieldErrors.court_ids ?? ""}</p>
      </fieldset>
      <div><label htmlFor={`${prefix}-state`} className="mb-1 block text-sm font-medium">Court state</label>
        <select id={`${prefix}-state`} value={state} name="court_state"
          onChange={(event) => { const value = courtStates.find((item) => item === event.target.value); if (value) setState(value); }}
          className="min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-sm"
          aria-invalid={Boolean(stateError)} aria-describedby={`${prefix}-state-error`}>
          {courtStates.map((value) => <option key={value} value={value}>{courtStateLabels[value]}</option>)}
        </select>
        <p id={`${prefix}-state-error`} className="mt-1 text-sm text-danger">{stateError}</p>
      </div>
      <fieldset className="sm:col-span-2" aria-invalid={Boolean(fieldErrors.weekdays)} aria-describedby={`${prefix}-days-error`}>
        <legend className="mb-2 text-sm font-medium">Days</legend>
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className={pricingButtonClass} onClick={() => setSelectedDays([0, 1, 2, 3, 4])}>Monday–Friday</button>
          <button type="button" className={pricingButtonClass} onClick={() => setSelectedDays([5, 6])}>Saturday–Sunday</button>
          <button type="button" className={pricingButtonClass} onClick={() => setSelectedDays([0, 1, 2, 3, 4, 5, 6])}>All days</button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {weekdays.map((label, day) => <label key={day} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="weekdays" value={day} checked={selectedDays.includes(day)}
              onChange={(event) => setSelectedDays(event.target.checked ? [...selectedDays, day].sort((a, b) => a - b) : selectedDays.filter((value) => value !== day))} />{label}
          </label>)}
        </div>
        <p id={`${prefix}-days-error`} className="mt-1 text-sm text-danger">{fieldErrors.weekdays ?? ""}</p>
      </fieldset>
      {([
        ["starts_at", "Start time", "text", rule ? minuteToTime(rule.starts_at_minute) : ""],
        ["ends_at", "End time", "text", rule ? minuteToTime(rule.ends_at_minute) : ""],
        ["starts_on", "Valid from (optional)", "date", rule?.starts_on ?? ""],
        ["ends_on", "Valid until (optional)", "date", rule?.ends_on ?? ""],
        ["price_per_hour", `Price per hour (${location.currency})`, "text", rule ? minorToMajor(rule.price_per_hour_minor) : ""],
      ] as const).map(([field, label, type, initial]) => <div key={field}>
        <label htmlFor={`${prefix}-${field}`} className="mb-1 block text-sm font-medium">{label}</label>
        <Input id={`${prefix}-${field}`} name={field} type={type} defaultValue={initial}
          required={field !== "starts_on" && field !== "ends_on"} inputMode={field === "price_per_hour" ? "decimal" : undefined}
          placeholder={field === "price_per_hour" ? "19.00" : type === "text" ? "HH:mm" : undefined}
          pattern={field === "starts_at" ? "([01][0-9]|2[0-3]):[0-5][0-9]" : field === "ends_at" ? "([01][0-9]|2[0-3]):[0-5][0-9]|24:00" : field === "price_per_hour" ? "[0-9]+([.][0-9]{1,2})?" : undefined}
          aria-invalid={Boolean(fieldErrors[field])} aria-describedby={fieldErrors[field] ? `${prefix}-${field}-error` : undefined} />
        {fieldErrors[field] && <p id={`${prefix}-${field}-error`} className="mt-1 text-sm text-danger">{fieldErrors[field]}</p>}
      </div>)}
      <div className="flex items-end gap-2">
        <button type="submit" className={pricingButtonClass} disabled={incompatible} aria-busy={pending}>{pending ? "Saving…" : "Save rule"}</button>
        <button type="button" className={pricingButtonClass} onClick={onCancel}>Cancel</button>
      </div>
    </fieldset>
    {rule && onRemove && <div className="mt-4 border-t border-border pt-4">
      <button type="button" className="rounded-control border border-danger px-3 py-2 text-sm font-semibold text-danger hover:bg-danger-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
        disabled={pending} onClick={onRemove}>Remove rule</button>
    </div>}
    <p className="mt-3 text-sm text-muted-foreground">Times include the start and exclude the end; adjacent intervals are valid. Use HH:mm; end time may be 24:00. Date boundaries are inclusive. Prices accept up to two decimal places.</p>
  </form>;
}
