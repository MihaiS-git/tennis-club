"use client";

import { useId, useRef, useState } from "react";
import { Input } from "@/components/input";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { Button } from "@/components/button";
import { useEditableFormBaseline } from "@/components/use-editable-form-baseline";
import type { AdminLocation } from "@/lib/admin/locations";
import type { AdminCourt } from "@/lib/admin/courts";
import { courtSurfaceLabels, courtEnvironmentLabels } from "@/lib/admin/courts-validation";
import { groupedWeeklySchedule, minuteToTime, timeToMinute, weekdayGroupLabel, weekdays, scheduleStatus, type DatedOpeningInterval, type OpeningHoursSchedule } from "@/lib/admin/opening-hours-validation";
import { supportsPricingState, courtStates, courtStateLabels, pricingDefinitionSchema, type PricingRuleSet } from "@/lib/pricing/validation";
import { useProfileFormDirty } from "@/app/profile/unsaved-changes";
import { minorToMajor } from "@/lib/pricing/money";
import { pricingOpeningHoursError } from "@/lib/pricing/resolution";

export type PricingCourt = Pick<AdminCourt, "id" | "location_id" | "name" | "surface" | "environment">;
const timeSuggestions = Array.from({ length: 48 }, (_, index) => minuteToTime(index * 30));
const startTimeOptions = timeSuggestions.map((time) => ({ value: time, label: time }));
const endTimeOptions = [...startTimeOptions, { value: "24:00", label: "24:00" }];

export function PricingRuleForm({ location, courts, rule, openingHours, schedules, today, pending, fieldErrors, onSave, onRemove, onEdit }: {
  location: Pick<AdminLocation, "id" | "currency">; courts: PricingCourt[]; rule?: PricingRuleSet;
  openingHours: DatedOpeningInterval[];
  schedules: OpeningHoursSchedule[];
  today: string;
  pending: boolean; fieldErrors: Record<string, string>; onSave: (input: unknown) => void;
  onRemove?: (trigger: HTMLButtonElement) => void;
  onEdit?: () => void;
}) {
  const prefix = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [selectedDays, setSelectedDays] = useState(rule?.weekdays ?? [0]);
  const [selectedCourts, setSelectedCourts] = useState(rule?.court_ids ?? []);
  const [outdoorState, setOutdoorState] = useState<"outdoor" | "covered">(rule?.court_state === "covered" ? "covered" : "outdoor");
  const selected = courts.filter((court) => selectedCourts.includes(court.id));
  const environment = selected[0]?.environment ?? courts[0]?.environment;
  const mixedEnvironments = selected.some((court) => court.environment !== environment);
  const indoorOnly = selected.length > 0 && environment === "indoor" && !mixedEnvironments;
  const state = indoorOnly ? "indoor" : outdoorState;
  const [localHoursError, setLocalHoursError] = useState("");
  const weeklySchedules = schedules.map((schedule) => ({
    ...schedule,
    groups: groupedWeeklySchedule(location.id, openingHours.filter((h) => h.schedule_id === schedule.id)),
  })).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  function parsedDefinition(form: HTMLFormElement) {
    const data = new FormData(form);
    return pricingDefinitionSchema.safeParse({
      location_id: location.id, court_ids: data.getAll("court_ids"),
      court_state: data.get("court_state"), weekdays: data.getAll("weekdays").map(Number),
      starts_at: data.get("starts_at"), ends_at: data.get("ends_at"),
      starts_on: data.get("starts_on"), ends_on: data.get("ends_on"),
      price_per_hour: data.get("price_per_hour"),
    });
  }
  function hoursError(form: HTMLFormElement) {
    const parsed = parsedDefinition(form);
    if (!parsed.success) return null;
    return pricingOpeningHoursError(openingHours, {
      location_id: location.id, weekdays: parsed.data.weekdays, starts_on: parsed.data.starts_on, ends_on: parsed.data.ends_on,
      starts_at_minute: timeToMinute(parsed.data.starts_at), ends_at_minute: timeToMinute(parsed.data.ends_at),
    }, today);
  }
  const { attach, dirty, valid, sync } = useEditableFormBaseline(
    ["court_ids", "court_state", "weekdays", "starts_at", "ends_at", "starts_on", "ends_on", "price_per_hour"],
    (field, value) => {
      const trimmed = value.trim();
      return field === "price_per_hour" && /^[0-9]+(?:\.[0-9]{1,2})?$/.test(trimmed)
        ? Number(trimmed).toFixed(2) : trimmed;
    },
    (form) => parsedDefinition(form).success && !hoursError(form),
  );
  useProfileFormDirty("Pricing", dirty);
  const incompatible = mixedEnvironments || selected
    .some((court) => !supportsPricingState(court.environment, state));
  const courtsError = mixedEnvironments
    ? "Indoor and Outdoor courts cannot share a pricing rule. Select courts from one environment, or clear the selection to switch."
    : fieldErrors.court_ids ?? "";
  const stateError = fieldErrors.court_state ?? (incompatible
    ? "Selected courts must share a valid state: indoor courts use Indoor; outdoor courts use Outdoor or Covered." : "");
  function update(form: HTMLFormElement) { sync(); setLocalHoursError(hoursError(form) ?? ""); }
  function changeCourts(ids: string[]) {
    setSelectedCourts(ids);
    onEdit?.();
    // Recheck the rendered controls, including the derived Indoor hidden input.
    requestAnimationFrame(() => { if (formRef.current) update(formRef.current); });
  }
  return <form aria-label="Pricing rule" ref={(form) => { formRef.current = form; attach(form); }}
    onInput={(event) => { onEdit?.(); update(event.currentTarget); }} onChange={(event) => { onEdit?.(); update(event.currentTarget); }}
    onSubmit={(event) => {
      event.preventDefault();
      if (pending || incompatible || !parsedDefinition(event.currentTarget).success) return;
      const currentHoursError = hoursError(event.currentTarget);
      if (currentHoursError) { setLocalHoursError(currentHoursError); return; }
      const data = new FormData(event.currentTarget);
      onSave({ ...(rule ? { rule_set_id: rule.rule_set_id, revision: rule.revision } : {}), location_id: location.id,
        court_ids: selectedCourts, court_state: state, weekdays: selectedDays,
        starts_at: data.get("starts_at"), ends_at: data.get("ends_at"), starts_on: data.get("starts_on"), ends_on: data.get("ends_on"),
        price_per_hour: data.get("price_per_hour"),
      });
    }}>
    <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
      <fieldset className="sm:col-span-2" aria-invalid={Boolean(courtsError)} aria-describedby={`${prefix}-courts-help ${prefix}-courts-error`}>
        <legend className="mb-2 text-sm font-medium">Courts</legend>
        <div className="mb-2 flex gap-2">
          <Button type="button" variant="secondary" size="small" disabled={!courts.length}
            onClick={() => changeCourts(courts.filter((court) => court.environment === environment).map((court) => court.id))}>Select all</Button>
          <Button type="button" variant="secondary" size="small" disabled={!selectedCourts.length}
            onClick={() => changeCourts([])}>Clear all</Button>
        </div>
        {environment && <p id={`${prefix}-courts-help`} className="mb-2 text-sm text-muted-foreground">Select all selects {courtEnvironmentLabels[environment]} courts. Select a court from one environment to choose that group.</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {courts.map((court) => <label key={court.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="court_ids" value={court.id} checked={selectedCourts.includes(court.id)}
              onChange={(event) => changeCourts(event.target.checked ? [...selectedCourts, court.id] : selectedCourts.filter((id) => id !== court.id))} />
            {court.name} — {courtSurfaceLabels[court.surface]} · {courtEnvironmentLabels[court.environment]}
          </label>)}
        </div>
        {!courts.length && <p>No courts at this location. Create a court first.</p>}
        <p id={`${prefix}-courts-error`} className="mt-1 text-sm text-danger">{courtsError}</p>
      </fieldset>
      {indoorOnly ? <input type="hidden" name="court_state" value="indoor" /> : <div><label htmlFor={`${prefix}-state`} className="mb-1 block text-sm font-medium">Court state</label>
        <select id={`${prefix}-state`} value={state} name="court_state"
          onInput={(event) => { const value = event.currentTarget.value; if (value === "outdoor" || value === "covered") setOutdoorState(value); }}
          onChange={(event) => { const value = event.target.value; if (value === "outdoor" || value === "covered") setOutdoorState(value); }}
          className="min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-sm"
          aria-invalid={Boolean(stateError)} aria-describedby={`${prefix}-state-error`}>
          {courtStates.filter((value) => value !== "indoor").map((value) => <option key={value} value={value}>{courtStateLabels[value]}</option>)}
        </select>
        <p id={`${prefix}-state-error`} className="mt-1 text-sm text-danger">{stateError}</p>
      </div>}
      <fieldset className="sm:col-span-2" aria-invalid={Boolean(fieldErrors.weekdays)} aria-describedby={`${prefix}-days-error`}>
        <legend className="mb-2 text-sm font-medium">Days</legend>
        <div className="mb-3 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="small" onClick={(event) => { const form = event.currentTarget.form; setSelectedDays([0, 1, 2, 3, 4]); requestAnimationFrame(() => { if (form) update(form); }); }}>Monday–Friday</Button>
          <Button type="button" variant="secondary" size="small" onClick={(event) => { const form = event.currentTarget.form; setSelectedDays([5, 6]); requestAnimationFrame(() => { if (form) update(form); }); }}>Saturday–Sunday</Button>
          <Button type="button" variant="secondary" size="small" onClick={(event) => { const form = event.currentTarget.form; setSelectedDays([0, 1, 2, 3, 4, 5, 6]); requestAnimationFrame(() => { if (form) update(form); }); }}>All days</Button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {weekdays.map((label, day) => <label key={day} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="weekdays" value={day} checked={selectedDays.includes(day)}
              onChange={(event) => setSelectedDays(event.target.checked ? [...selectedDays, day].sort((a, b) => a - b) : selectedDays.filter((value) => value !== day))} />{label}
          </label>)}
        </div>
        <p id={`${prefix}-days-error`} className="mt-1 text-sm text-danger">{fieldErrors.weekdays ?? ""}</p>
      </fieldset>
      <section aria-label="Opening hours" className="rounded-control border border-border bg-surface-muted p-3 text-sm sm:col-span-2">
        <h3 className="mb-2 font-semibold">Opening hours</h3>
        {!schedules.length && <p>Not configured. Configure this location&apos;s opening hours before saving pricing.</p>}
        {weeklySchedules.map((schedule) => <div key={schedule.id} className="mb-3 last:mb-0">
          <p className="mb-1 font-medium">{schedule.starts_on} – {schedule.ends_on ?? "Unlimited"} · {scheduleStatus(schedule, today)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {schedule.groups.map((group) => <div key={group.weekdays.join(",")} className="contents">
            <dt className="font-medium">{weekdayGroupLabel(group.weekdays)}</dt>
            <dd>{group.intervals.length ? group.intervals.map((interval) => `${minuteToTime(interval.opens_at_minute)}–${minuteToTime(interval.closes_at_minute)}`).join(", ") : "Closed"}</dd>
          </div>)}
          </dl>
        </div>)}
      </section>
      {([
        ["starts_at", "Start time", "text", rule ? minuteToTime(rule.starts_at_minute) : ""],
        ["ends_at", "End time", "text", rule ? minuteToTime(rule.ends_at_minute) : ""],
        ["starts_on", "Valid from (optional)", "date", rule?.starts_on ?? ""],
        ["ends_on", "Valid until (optional)", "date", rule?.ends_on ?? ""],
        ["price_per_hour", `Price per hour (${location.currency})`, "text", rule ? minorToMajor(rule.price_per_hour_minor) : ""],
      ] as const).map(([field, label, type, initial]) => <div key={field}>
        <label htmlFor={`${prefix}-${field}`} className="mb-1 block text-sm font-medium">{label}</label>
        {field === "starts_at" || field === "ends_at" ? <SearchableCombobox
          id={`${prefix}-${field}`} name={field} defaultValue={initial} allowCustomValue required
          options={field === "starts_at" ? startTimeOptions : endTimeOptions}
          placeholder="HH:mm" listLabel={`${label} suggestions`} emptyMessage="No matching times. You can type a time manually."
          pattern={field === "starts_at" ? "([01][0-9]|2[0-3]):[0-5][0-9]" : "([01][0-9]|2[0-3]):[0-5][0-9]|24:00"}
          onValueChange={() => {
            onEdit?.();
            // Option selection updates the input on React's next render, without a native change event.
            requestAnimationFrame(() => { if (formRef.current) update(formRef.current); });
          }}
          aria-invalid={Boolean(fieldErrors[field] || (field === "ends_at" && localHoursError))}
          aria-describedby={fieldErrors[field] || (field === "ends_at" && localHoursError) ? `${prefix}-${field}-error` : undefined}
        /> : <Input id={`${prefix}-${field}`} name={field} type={type} defaultValue={initial}
          required={field !== "starts_on" && field !== "ends_on"} inputMode={field === "price_per_hour" ? "decimal" : undefined}
          placeholder={field === "price_per_hour" ? "19.00" : undefined}
          pattern={field === "price_per_hour" ? "[0-9]+([.][0-9]{1,2})?" : undefined}
          aria-invalid={Boolean(fieldErrors[field])} aria-describedby={fieldErrors[field] ? `${prefix}-${field}-error` : undefined} />}
        {(fieldErrors[field] || (field === "ends_at" && localHoursError)) && <p id={`${prefix}-${field}-error`} className="mt-1 text-sm text-danger">{fieldErrors[field] || localHoursError}</p>}
      </div>)}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-4 sm:col-span-2">
        {rule && onRemove ? <Button type="button" variant="destructive" size="small" disabled={pending} onClick={(event) => onRemove(event.currentTarget)}>Remove rule</Button> : <span />}
        <Button type="submit" fullWidth={false} disabled={pending || incompatible || !valid || Boolean(rule && !dirty)} aria-busy={pending}>{pending ? "Saving…" : "Save rule"}</Button>
      </div>
    </fieldset>
    <p className="mt-3 text-sm text-muted-foreground">Times include the start and exclude the end; adjacent intervals are valid. Use HH:mm; end time may be 24:00. Date boundaries are inclusive. Prices accept up to two decimal places.</p>
  </form>;
}
