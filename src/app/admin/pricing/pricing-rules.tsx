"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AdminToolbar } from "@/components/admin-page-controls";
import { Button, DialogCloseButton } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { ModalDialog } from "@/components/modal-dialog";
import { toast } from "sonner";
import type { AdminLocation } from "@/lib/admin/locations";
import { weekdays, minuteToTime, type OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { courtStateLabels, type PricingRuleSet, type PricingMutationResult } from "@/lib/pricing/validation";
import { formatMoney } from "@/lib/pricing/money";
import { formatWeekdays } from "@/lib/pricing/resolution";
import { PricingRuleForm, type PricingCourt } from "./pricing-rule-form";
import { savePricingRuleAction, removePricingRuleAction } from "./actions";
import { PricingLocationSelect } from "./location-select";

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}
function validity(rule: PricingRuleSet) {
  if (rule.starts_on && rule.ends_on) return `${displayDate(rule.starts_on)} – ${displayDate(rule.ends_on)}`;
  if (rule.starts_on) return `From ${displayDate(rule.starts_on)}`;
  if (rule.ends_on) return `Until ${displayDate(rule.ends_on)}`;
  return "All dates";
}

export function PricingRules({ location, locations = [], courts, rules, openingHours }: {
  location: Pick<AdminLocation, "id" | "name" | "currency" | "timezone">;
  locations?: Pick<AdminLocation, "id" | "name" | "is_active">[];
  courts: PricingCourt[]; rules: PricingRuleSet[]; openingHours: OpeningInterval[];
}) {
  const pendingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ rule?: PricingRuleSet } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  async function mutate(operation: () => Promise<PricingMutationResult>) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(""); setFieldErrors({});
    try {
      const result = await operation();
      if (result.ok) { setRemoving(false); setEditing(null); toast.success("Pricing updated."); }
      else if (result.reason === "invalid-input") { setError("Check the pricing rule."); setFieldErrors(result.fieldErrors); }
      else setError(result.reason === "overlap"
        ? "This rule overlaps an existing rule for the same court, state, weekday, dates and time."
        : "This location or pricing rule no longer exists.");
    } catch { setError("Unable to change pricing. Please try again."); }
    finally { pendingRef.current = false; setPending(false); }
  }
  function close() { if (!pendingRef.current) { setRemoving(false); setEditing(null); setError(""); setFieldErrors({}); } }
  function begin(rule?: PricingRuleSet) { setEditing({ rule }); setError(""); setFieldErrors({}); }
  function activate(rule: PricingRuleSet) {
    return {
      onClick: () => begin(rule),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); begin(rule); }
      },
    };
  }
  const displayedRules = rules.map((item) => ({
    item,
    courtNames: courts.filter((court) => item.court_ids.includes(court.id)).map((court) => court.name).join(", "),
  }));
  return <section aria-label={`${location.name} pricing rules`}>
    <AdminToolbar
      primary={locations.length > 0 && <PricingLocationSelect locations={locations} selectedId={location.id} />}
      action={<Button type="button" variant="secondary" size="small" disabled={pending || courts.length === 0} onClick={() => begin()}>Add rule</Button>}
      metadata={<p>Currency: {location.currency} · Times: {location.timezone} · Pricing must fit within configured opening hours.</p>}
    />
    {rules.length === 0 ? <p className="rounded-card border border-border bg-surface p-6 text-muted-foreground">No pricing rules configured.</p>
      : <><div className="space-y-3 lg:hidden">{displayedRules.map(({ item, courtNames }) => <article key={item.rule_set_id} role="button" tabIndex={0}
        aria-label={`Edit pricing rule for ${courtNames}`}
        className="cursor-pointer rounded-card border border-border bg-surface p-5 transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
        {...activate(item)}>
        <p className="font-semibold">{courtNames}</p>
        <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-2 text-sm">
          <dt>State</dt><dd>{courtStateLabels[item.court_state]}</dd>
          <dt>Days</dt><dd>{formatWeekdays(item.weekdays)}</dd>
          <dt>Time</dt><dd>{minuteToTime(item.starts_at_minute)}–{minuteToTime(item.ends_at_minute)}</dd>
          <dt>Validity</dt><dd>{validity(item)}</dd>
          <dt>Price/hour</dt><dd>{formatMoney(item.price_per_hour_minor, location.currency)}</dd>
        </dl>
      </article>)}</div><div className="hidden overflow-x-auto rounded-card border border-border bg-surface lg:block">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground"><tr>
            <th scope="col" className="px-3 py-3">Courts</th><th scope="col" className="px-3 py-3">State</th>
            <th scope="col" className="px-3 py-3">Days</th><th scope="col" className="px-3 py-3">Time</th>
            <th scope="col" className="px-3 py-3">Validity</th><th scope="col" className="px-3 py-3">Price/hour</th>
          </tr></thead>
          <tbody>{displayedRules.map(({ item, courtNames }) => <tr key={item.rule_set_id} tabIndex={0} aria-label={`Edit pricing rule for ${courtNames}`}
            className="cursor-pointer border-t border-border align-top transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
            {...activate(item)}>
            <td className="px-3 py-3 font-medium">{courtNames}</td>
            <td className="px-3 py-3">{courtStateLabels[item.court_state]}</td>
            <td className="px-3 py-3">{formatWeekdays(item.weekdays)}</td>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{minuteToTime(item.starts_at_minute)}–{minuteToTime(item.ends_at_minute)}</td>
            <td className="px-3 py-3">{validity(item)}</td>
            <td className="whitespace-nowrap px-3 py-3 font-semibold">{formatMoney(item.price_per_hour_minor, location.currency)}</td>
          </tr>)}</tbody>
        </table>
        <p className="sr-only">Times include their start and exclude their end. {weekdays[0]} starts the week.</p>
      </div></>}
    {editing && createPortal(<ModalDialog ref={dialogRef} active aria-labelledby="pricing-dialog-title"
      onClose={close} onCancel={(event) => { if (pendingRef.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto w-[calc(100%-1.5rem)] max-w-3xl rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50 sm:w-[calc(100%-2rem)]">
      <div className="p-4 sm:p-6">
        <header className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
          <h2 id="pricing-dialog-title" className="font-heading text-xl font-semibold">{editing.rule ? "Edit pricing" : "Add pricing"}</h2>
          <DialogCloseButton disabled={pending} onClick={() => dialogRef.current?.close()} />
        </header>
        {error && !removing && <p role="alert" className="mb-4 text-danger">{error}</p>}
        <PricingRuleForm key={editing.rule?.rule_set_id ?? "new"} location={location} courts={courts} rule={editing.rule} openingHours={openingHours}
          pending={pending} fieldErrors={fieldErrors} onSave={(input) => void mutate(() => savePricingRuleAction(input))}
          onRemove={editing.rule ? (trigger) => { removeTriggerRef.current = trigger; setError(""); setRemoving(true); } : undefined} />
        <ConfirmationDialog open={removing && Boolean(editing.rule)} title="Remove pricing rule?"
          message={editing.rule ? `Pricing for ${courts.filter((court) => editing.rule?.court_ids.includes(court.id)).map((court) => court.name).join(", ")} on ${formatWeekdays(editing.rule.weekdays)} will no longer apply.` : ""}
          confirmLabel="Remove rule" pending={pending} error={error} returnFocusRef={removeTriggerRef}
          onClose={() => { if (!pendingRef.current) { setRemoving(false); setError(""); } }}
          onConfirm={() => { const rule = editing.rule; if (rule) void mutate(() => removePricingRuleAction({ rule_set_id: rule.rule_set_id, location_id: location.id })); }} />
      </div>
    </ModalDialog>, document.body)}
  </section>;
}
