"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { DialogHeader } from "@/components/dialog-layout";
import { Input } from "@/components/input";
import { ModalDialog } from "@/components/modal-dialog";
import { useEditableFormBaseline } from "@/components/use-editable-form-baseline";
import type { AdminCoachingCurrency, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";
import {
  coachingFieldErrors, coachingProgramDurations, coachingProgramFieldsSchema, coachingProgramTypeLabels, coachingProgramTypes, formatCoachingDuration,
  hasParticipantRates, type CoachingProgramType,
} from "@/lib/coaching/validation";
import { majorAmountSchema, minorToMajor, type LocationCurrency } from "@/lib/pricing/money";
import { saveCoachingProgramAction } from "../actions";
import { coachingFailureMessages, formText, hintClass, labelClass, optionalNumber, selectClass, textareaClass, useFieldErrors } from "../coaching-form";

const editableFields = ["name", "description", "program_type", "duration", "min_participants", "max_participants", "court_rental_included", "is_active"];

function programFields(form: HTMLFormElement) {
  const data = new FormData(form);
  const durations = [...new Set(data.getAll("duration").map(Number))].sort((a, b) => a - b);
  return {
    name: formText(data, "name"), description: formText(data, "description"), program_type: formText(data, "program_type"),
    durations, min_participants: optionalNumber(formText(data, "min_participants")),
    max_participants: optionalNumber(formText(data, "max_participants")),
    court_rental_included: formText(data, "court_rental_included") === "true", is_active: formText(data, "is_active") === "true",
  };
}

// Participant-limit problems shown while editing; Save stays disabled until they are fixed.
type LimitField = "min_participants" | "max_participants";
function limitErrors(fields: unknown): Partial<Record<LimitField, string>> {
  const parsed = coachingProgramFieldsSchema.safeParse(fields);
  if (parsed.success) return {};
  const { min_participants, max_participants } = coachingFieldErrors(parsed.error.issues);
  return { min_participants, max_participants };
}

const priceKey = (currency: LocationCurrency, minutes: number) => `${currency}:${minutes}`;
type PriceEntry = { currency: LocationCurrency; duration_minutes: number };

// Club prices keyed by currency and duration. Empty means not configured, never zero;
// a saved price is removed only through its explicit Remove action.
function useClubPrices(program: AdminCoachingProgram | undefined, prices: readonly AdminCoachingPrice[]) {
  const club = new Map(prices.filter((price) => price.coach_user_id === null && price.program_id === program?.id)
    .map((price) => [priceKey(price.currency, price.duration_minutes), price]));
  const baseline = (key: string) => { const price = club.get(key); return price ? minorToMajor(price.amount_minor) : ""; };
  const initial = () => Object.fromEntries([...club.keys()].map((key) => [key, baseline(key)]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  function reset() { setValues(initial()); setRemoved(new Set()); setErrors({}); }
  function error(key: string) {
    if (removed.has(key)) return undefined;
    const value = (values[key] ?? "").trim();
    if (value === "") return club.has(key) ? "Enter a price, or use Remove to clear it." : undefined;
    return majorAmountSchema.safeParse(value).success ? errors[key] : "Enter a positive amount with at most two decimal places.";
  }
  // Only changed entries for the selected durations are submitted, in a stable order.
  function changes(currencies: readonly AdminCoachingCurrency[], durations: readonly number[]) {
    const keys = currencies.flatMap(({ currency }) => durations.map((minutes) => ({ key: priceKey(currency, minutes), currency, duration_minutes: minutes })));
    return {
      saved: keys.filter(({ key }) => !removed.has(key) && (values[key] ?? "").trim() !== "" && (values[key] ?? "").trim() !== baseline(key))
        .map(({ key, ...entry }) => ({ ...entry, key, amount: (values[key] ?? "").trim() })),
      removed: keys.filter(({ key }) => removed.has(key) && club.has(key)),
      valid: keys.every(({ key }) => !error(key)),
    };
  }
  return { club, values, removed, setValue: (key: string, value: string) => { setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" })); },
  toggleRemoved: (key: string) => setRemoved((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; }),
  error, setErrors, changes, reset };
}

// Group/Junior programs have no duration prices: their club rates per player count are set under Prices.
function selectedDurations(form: HTMLFormElement) {
  const fields = programFields(form);
  return coachingProgramTypes.some((type) => type === fields.program_type && hasParticipantRates(type)) ? [] : fields.durations;
}

export function ProgramDialog({ program, currencies = [], prices = [], open: controlledOpen, onOpenChange }: {
  program?: AdminCoachingProgram; currencies?: AdminCoachingCurrency[]; prices?: AdminCoachingPrice[];
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, setPending] = useState(false);
  const { fieldErrors, setFieldErrors, errorProps, fieldError } = useFieldErrors(prefix);
  // An existing program with missing or invalid limits shows why at once.
  const [limits, setLimits] = useState(() => program ? limitErrors({ name: program.name, description: program.description,
    program_type: program.program_type, durations: program.durations, min_participants: program.min_participants,
    max_participants: program.max_participants, court_rental_included: program.court_rental_included, is_active: program.is_active }) : {});
  const limitProps = (field: LimitField) => fieldErrors[field] || !limits[field] ? errorProps(field)
    : { "aria-invalid": true, "aria-describedby": `${prefix}-${field}-error` };
  const limitError = (field: LimitField) => fieldError(field)
    || (limits[field] && <p id={`${prefix}-${field}-error`} className="mt-1 text-sm text-danger">{limits[field]}</p>);
  const { attach, dirty, valid, sync, submitted, commit } = useEditableFormBaseline(editableFields, undefined,
    (form) => coachingProgramFieldsSchema.safeParse(programFields(form)).success);
  const durations = program ? coachingProgramDurations.filter((minutes) => program.durations.includes(minutes)) : [60];
  const [selected, setSelected] = useState<number[]>(durations);
  const [programType, setProgramType] = useState<CoachingProgramType>(program?.program_type ?? "private");
  const participantRated = hasParticipantRates(programType);
  const clubPrices = useClubPrices(program, prices);
  const priceChanges = clubPrices.changes(currencies, participantRated ? [] : selected);
  const priceChanged = priceChanges.saved.length > 0 || priceChanges.removed.length > 0;
  // Removing a duration deletes its prices on save (existing rule); state that before saving.
  const droppedPrices = (program?.durations ?? []).filter((minutes) => !selected.includes(minutes)).flatMap((minutes) => {
    const affected = prices.filter((price) => price.program_id === program?.id && price.duration_minutes === minutes);
    return affected.length ? [{ minutes, club: affected.filter((price) => price.coach_user_id === null).length,
      coach: affected.filter((price) => price.coach_user_id !== null).length }] : [];
  });
  function onFormChange(event: React.FormEvent<HTMLFormElement>) {
    sync();
    setLimits(limitErrors(programFields(event.currentTarget)));
    const fields = programFields(event.currentTarget);
    if (fields.durations.join() !== selected.join()) setSelected(fields.durations);
    const type = coachingProgramTypes.find((candidate) => candidate === fields.program_type);
    if (type && type !== programType) setProgramType(type);
  }

  async function submit(form: HTMLFormElement) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setFieldErrors({});
    const saved = submitted(form);
    const notification = toast.loading("Saving program…");
    const { saved: savedPrices, removed: removedPrices } = clubPrices.changes(currencies, selectedDurations(form));
    try {
      const result = await saveCoachingProgramAction({ ...(program ? { id: program.id } : {}), fields: programFields(form),
        ...savedPrices.length > 0 && { club_prices: savedPrices.map(({ currency, duration_minutes, amount }) => ({ currency, duration_minutes, amount })) },
        ...removedPrices.length > 0 && { removed_club_prices: removedPrices.map(({ currency, duration_minutes }): PriceEntry => ({ currency, duration_minutes })) } });
      if (result.ok) {
        commit(saved);
        toast.success(program ? "Program updated." : "Program created.", { id: notification });
        dialogRef.current?.close();
        router.refresh();
      } else if (result.reason === "invalid-input") {
        toast.dismiss(notification); setFieldErrors(result.fieldErrors);
        // Entry errors name their submitted index; show them beside that price.
        clubPrices.setErrors(Object.fromEntries(savedPrices.flatMap((price, index) => {
          const message = result.fieldErrors[`club_prices.${index}`];
          return message ? [[price.key, message]] : [];
        })));
      } else {
        toast.error(coachingFailureMessages[result.reason], { id: notification });
      }
    } catch {
      toast.error("Unable to save program. Please try again.", { id: notification });
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }

  return <>
    {!program && controlledOpen === undefined && <Button type="button" variant="secondary" size="small" fullWidth={false}
      onClick={() => { setFieldErrors({}); setLimits({}); clubPrices.reset(); setSelected(durations); setProgramType("private"); setOpen(true); }}>Create program</Button>}
    <ModalDialog ref={dialogRef} active={open} aria-labelledby={`${prefix}-title`}
      onClose={() => setOpen(false)} onCancel={(event) => { if (pendingRef.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50">
      {open && <div className="p-5 sm:p-6">
        <div className="mb-5"><DialogHeader titleId={`${prefix}-title`} title={program ? "Edit program" : "Create program"}
          disabled={pending} onClose={() => dialogRef.current?.close()} /></div>
        <form ref={attach} onInput={onFormChange} onChange={onFormChange} onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
          <fieldset disabled={pending} className="space-y-4">
            <div>
              <label htmlFor={`${prefix}-name`} className={labelClass}>Name</label>
              <Input id={`${prefix}-name`} name="name" required maxLength={100} defaultValue={program?.name ?? ""} {...errorProps("name")} />
              {fieldError("name")}
            </div>
            <div>
              <label htmlFor={`${prefix}-description`} className={labelClass}>Description</label>
              <textarea id={`${prefix}-description`} name="description" rows={3} maxLength={2000} className={textareaClass}
                defaultValue={program?.description ?? ""} {...errorProps("description")} />
              {fieldError("description")}
            </div>
            <div>
              <label htmlFor={`${prefix}-program_type`} className={labelClass}>Program type</label>
              <select id={`${prefix}-program_type`} name="program_type" className={selectClass} defaultValue={program?.program_type ?? "private"} {...errorProps("program_type")}>
                {coachingProgramTypes.map((type) => <option key={type} value={type}>{coachingProgramTypeLabels[type]}</option>)}
              </select>{fieldError("program_type")}
            </div>
            <fieldset aria-describedby={`${prefix}-durations-hint`}>
              <legend className={labelClass}>Durations</legend>
              <div className="flex flex-wrap gap-2">
                {coachingProgramDurations.map((minutes) => <label key={minutes} className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-border px-3 text-sm has-checked:border-primary has-checked:bg-surface-muted">
                  <input type="checkbox" name="duration" value={minutes} defaultChecked={durations.includes(minutes)} className="accent-primary" />
                  {formatCoachingDuration(minutes)}
                </label>)}
              </div>
              <p id={`${prefix}-durations-hint`} className={hintClass}>60, 90 or 120 minutes. Prices are set per duration.</p>
              {fieldError("durations")}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <p id={`${prefix}-participants-hint`} className={`${hintClass} sm:col-span-2`}>Required for active programs (1–100). Private and Semi-private lessons are booked online for a player count within these limits; Group and Junior prices are set for each count.</p>
              <div>
                <label htmlFor={`${prefix}-min_participants`} className={labelClass}>Minimum players</label>
                <Input id={`${prefix}-min_participants`} name="min_participants" type="number" min={1} max={100} placeholder="Not set"
                  defaultValue={program?.min_participants ?? ""} {...limitProps("min_participants")} />
                {limitError("min_participants")}
              </div>
              <div>
                <label htmlFor={`${prefix}-max_participants`} className={labelClass}>Maximum players</label>
                <Input id={`${prefix}-max_participants`} name="max_participants" type="number" min={1} max={100} placeholder="Not set"
                  defaultValue={program?.max_participants ?? ""} {...limitProps("max_participants")} />
                {limitError("max_participants")}
              </div>
            </div>
            <div>
              <label htmlFor={`${prefix}-court_rental_included`} className={labelClass}>Court rental</label>
              <select id={`${prefix}-court_rental_included`} name="court_rental_included" className={selectClass}
                defaultValue={String(program?.court_rental_included ?? false)} {...errorProps("court_rental_included")}>
                <option value="true">Included in the price</option>
                <option value="false">Not included in the price</option>
              </select>{fieldError("court_rental_included")}
            </div>
            <div>
              <label htmlFor={`${prefix}-is_active`} className={labelClass}>Status</label>
              <select id={`${prefix}-is_active`} name="is_active" className={selectClass} defaultValue={String(program?.is_active ?? true)} {...errorProps("is_active")}>
                <option value="true">Active</option><option value="false">Inactive</option>
              </select>
              <p className={hintClass}>Inactive programs are hidden from the public Coaching page.</p>
              {fieldError("is_active")}
            </div>
            {participantRated ? <p className="rounded-control border border-border px-3 py-2.5 text-sm text-muted-foreground">
              {coachingProgramTypeLabels[programType]} sessions are organized by the coach or club and paid at the club. Set their club prices
              per person for 60 minutes, by number of players, under Prices.
              {droppedPrices.length > 0 && <span role="status" className="mt-1 block text-foreground">
                Saving also removes the earlier lesson-length prices stored for {droppedPrices.map(({ minutes }) => formatCoachingDuration(minutes)).join(", ")}.
              </span>}
            </p> : <ClubPrices prefix={prefix} currencies={currencies} durations={selected} prices={clubPrices} dropped={droppedPrices} />}
            {/* Kept in view while long price lists scroll. */}
            <div className="sticky bottom-0 -mx-5 -mb-5 flex justify-end border-t border-border bg-surface px-5 py-4 sm:-mx-6 sm:-mb-6 sm:px-6">
              <Button type="submit" fullWidth={false} disabled={pending || !valid || !priceChanges.valid || (program ? !dirty && !priceChanged : false)} aria-busy={pending}>
                {pending ? "Saving…" : "Save program"}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>}
    </ModalDialog>
  </>;
}

function ClubPrices({ prefix, currencies, durations, prices, dropped }: {
  prefix: string; currencies: readonly AdminCoachingCurrency[]; durations: readonly number[];
  prices: ReturnType<typeof useClubPrices>; dropped: { minutes: number; club: number; coach: number }[];
}) {
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  return <fieldset aria-describedby={`${prefix}-club-prices-hint`}>
    <legend className={labelClass}>Club prices</legend>
    <p id={`${prefix}-club-prices-hint`} className="mb-3 text-xs text-muted-foreground">
      Club-wide default price per duration in each currency; a lesson is charged in its location’s currency.
      Leave a price empty to keep it not set. Coaches set their own individual prices.
    </p>
    {dropped.length > 0 && <p role="status" className="mb-3 rounded-control border border-warning bg-warning-background px-3 py-2 text-sm text-foreground">
      Saving removes {dropped.map(({ minutes, club, coach }) => `${formatCoachingDuration(minutes)} with ${[club && count(club, "club price"), coach && count(coach, "coach price")].filter(Boolean).join(" and ")}`).join("; ")}.
      Select the duration again to keep its prices.
    </p>}
    {!currencies.length ? <p className="text-sm text-muted-foreground">No locations yet. Add a location before setting club prices.</p>
      : !durations.length ? <p className="text-sm text-muted-foreground">Select a duration to set its prices.</p>
      : <div className="grid gap-3 sm:grid-cols-2">
        {currencies.map(({ currency }) => <section key={currency} aria-label={`Club prices in ${currency}`} className="rounded-control border border-border px-3 py-2.5">
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {currency}
          </h3>
          <ul className="space-y-2">
            {durations.map((minutes) => {
              const key = priceKey(currency, minutes);
              const id = `${prefix}-price-${key}`;
              const stored = prices.club.get(key);
              const removed = prices.removed.has(key);
              const error = prices.error(key);
              const label = `${currency} ${formatCoachingDuration(minutes)} club price`;
              return <li key={minutes}>
                <div className="flex items-center gap-2">
                  <label htmlFor={id} className="w-16 shrink-0 text-sm">{formatCoachingDuration(minutes)}<span className="sr-only"> club price in {currency}</span></label>
                  <div className={`flex min-h-9 w-32 items-center rounded-control border bg-surface pr-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-focus/20 ${error ? "border-danger" : "border-border"}`}>
                    <input id={id} value={removed ? "" : prices.values[key] ?? ""} inputMode="decimal" placeholder={removed ? "Removed" : "Not set"}
                      disabled={removed} onChange={(event) => prices.setValue(key, event.target.value)}
                      aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
                      className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none disabled:opacity-60" />
                    <span className="text-xs font-semibold text-muted-foreground">{currency}</span>
                  </div>
                  {stored && <Button type="button" variant="subtle" size="small" fullWidth={false} onClick={() => prices.toggleRemoved(key)}
                    aria-label={`${removed ? "Keep" : "Remove"} ${label}`}>{removed ? "Undo" : "Remove"}</Button>}
                </div>
                {removed && <p className="mt-1 text-xs text-muted-foreground">Removed when you save.</p>}
                {error && <p id={`${id}-error`} className="mt-1 text-xs text-danger">{error}</p>}
              </li>;
            })}
          </ul>
        </section>)}
      </div>}
  </fieldset>;
}
