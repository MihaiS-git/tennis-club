"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { AdminToolbar } from "@/components/admin-page-controls";
import { FilterClearSlot } from "@/components/filter-clear-slot";
import { Button } from "@/components/button";
import { DialogHeader } from "@/components/dialog-layout";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { ModalDialog } from "@/components/modal-dialog";
import { toast } from "sonner";
import type { AdminLocation } from "@/lib/admin/locations";
import { weekdays, minuteToTime, type DatedOpeningInterval, type OpeningHoursSchedule } from "@/lib/admin/opening-hours-validation";
import { courtStates, courtStateLabels, type PricingRuleSet, type PricingMutationResult } from "@/lib/pricing/validation";
import { formatMoney } from "@/lib/pricing/money";
import { formatWeekdays } from "@/lib/pricing/resolution";
import { PricingRuleForm, type PricingCourt } from "./pricing-rule-form";
import { savePricingRuleAction, removePricingRuleAction } from "./actions";
import { useLocationPanelActive } from "../locations/location-workspace";
import { pricingFilterKeys, pricingInventorySchema, pricingSortColumns, selectPricingRules, type PricingInventoryOptions } from "./inventory";
import { localToday } from "@/lib/courts/local-time";

const controlClass = "min-h-11 w-full min-w-0 rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-foreground";
const filterClass = "flex min-w-0 flex-col gap-1.5 font-medium text-primary";

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}
function validity(rule: PricingRuleSet) {
  if (rule.starts_on && rule.ends_on) return `${displayDate(rule.starts_on)} – ${displayDate(rule.ends_on)}`;
  if (rule.starts_on) return `From ${displayDate(rule.starts_on)}`;
  if (rule.ends_on) return `Until ${displayDate(rule.ends_on)}`;
  return "All dates";
}

export function PricingRules({ location, courts, rules, openingHours, schedules }: {
  location: Pick<AdminLocation, "id" | "name" | "currency" | "timezone">;
  courts: PricingCourt[]; rules: PricingRuleSet[]; openingHours: DatedOpeningInterval[];
  schedules: OpeningHoursSchedule[];
}) {
  const panelActive = useLocationPanelActive();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const options = pricingInventorySchema.parse(Object.fromEntries(
    [...pricingFilterKeys, "pricingSort", "pricingDir"].map((key) => {
      const values = searchParams.getAll(key);
      return [key, values.length === 1 ? values[0] : undefined];
    }),
  ));
  const hasFilters = pricingFilterKeys.some((key) => options[key] !== undefined);
  function navigate(changes: Partial<Record<keyof PricingInventoryOptions, string>>) {
    // Read the current URL so rapid updates preserve each other and workspace state.
    const query = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) query.set(key, value); else query.delete(key);
    }
    query.delete("page");
    if (pathname.startsWith("/admin/locations/")) query.set("tab", "pricing");
    window.history.pushState(null, "", `${pathname}?${query}${window.location.hash}`);
  }
  function sort(column: PricingInventoryOptions["pricingSort"]) {
    navigate({ pricingSort: column, pricingDir: options.pricingSort === column && options.pricingDir === "asc" ? "desc" : "asc" });
  }
  const pendingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ rule?: PricingRuleSet } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  async function mutate(operation: () => Promise<PricingMutationResult>) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setFieldErrors({});
    const notification = toast.loading("Updating pricing…");
    try {
      const result = await operation();
      if (result.ok) { setRemoving(false); setEditing(null); toast.success("Pricing updated.", { id: notification }); }
      else if (result.reason === "invalid-input") {  toast.dismiss(notification); setFieldErrors(result.fieldErrors); }
      else {
        if (result.reason === "stale" || result.reason === "not-found") router.refresh();
        toast.error(result.reason === "stale" ? "This pricing rule has changed. Close and reopen it to review the latest values."
        : result.reason === "overlap"
        ? "This rule overlaps an existing rule for the same court, state, weekday, dates and time."
        : "This location or pricing rule no longer exists.", { id: notification });
      }
    } catch { toast.error("Unable to change pricing. Please try again.", { id: notification }); }
    finally { pendingRef.current = false; setPending(false); }
  }
  function close() { if (!pendingRef.current) { setRemoving(false); setEditing(null); setFieldErrors({}); } }
  function begin(rule?: PricingRuleSet) { setEditing({ rule }); setFieldErrors({}); }
  function activate(rule: PricingRuleSet) {
    return {
      onClick: () => begin(rule),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); begin(rule); }
      },
    };
  }
  const displayedRules = selectPricingRules(rules, courts, options);
  return <section aria-label={`${location.name} pricing rules`}>
    <AdminToolbar
      primary={null}
      action={<Button type="button" variant="secondary" size="small" disabled={pending || courts.length === 0} onClick={() => begin()}>Add rule</Button>}
      metadata={<p>Currency: {location.currency} · Times: {location.timezone} · Pricing must fit within configured opening hours.</p>}
    />
    <div className="mb-4 grid grid-cols-1 items-end gap-3 text-sm sm:grid-cols-2 xl:flex xl:flex-wrap" role="group" aria-label="Pricing filters">
      <label className={`${filterClass} xl:w-44`}>Court
        <select value={options.pricingCourt ?? ""} className={controlClass} onChange={(event) => navigate({ pricingCourt: event.target.value })}>
          <option value="">All courts</option>
          {[...courts].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" })).map((court) => <option key={court.id} value={court.id}>{court.name}</option>)}
        </select>
      </label>
      <label className={`${filterClass} xl:w-36`}>Court state
        <select value={options.pricingState ?? ""} className={controlClass} onChange={(event) => navigate({ pricingState: event.target.value })}>
          <option value="">All states</option>{courtStates.map((state) => <option key={state} value={state}>{courtStateLabels[state]}</option>)}
        </select>
      </label>
      <label className={`${filterClass} xl:w-40`}>Day
        <select value={options.pricingDay ?? ""} className={controlClass} onChange={(event) => navigate({ pricingDay: event.target.value })}>
          <option value="">All days</option>{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
        </select>
      </label>
      <label className={`${filterClass} xl:w-44`}>Applies on
        <input type="date" value={options.pricingDate ?? ""} className={controlClass} onChange={(event) => navigate({ pricingDate: event.target.value })} />
      </label>
      <FilterClearSlot active={hasFilters}>
        <Button type="button" variant="subtle" size="small" onClick={() => navigate(Object.fromEntries(pricingFilterKeys.map((key) => [key, ""])))}>Reset filters</Button>
      </FilterClearSlot>
    </div>
    <div className="mb-4 flex items-end gap-3 text-sm lg:hidden">
      <label className={`${filterClass} flex-1`}>Sort pricing by
        <select className={controlClass} value={options.pricingSort} onChange={(event) => navigate({ pricingSort: event.target.value, pricingDir: "asc" })}>
          {pricingSortColumns.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <Button type="button" variant="secondary" size="small" aria-label={`Sort ${options.pricingDir === "asc" ? "descending" : "ascending"}`} onClick={() => sort(options.pricingSort)}>
        {options.pricingDir === "asc" ? <ArrowUp aria-hidden="true" size={14} /> : <ArrowDown aria-hidden="true" size={14} />}
        {options.pricingDir === "asc" ? "Ascending" : "Descending"}
      </Button>
    </div>
    {displayedRules.length === 0 ? <p role="status" className="rounded-card border border-border bg-surface p-6 text-muted-foreground">{hasFilters ? "No pricing rules match these filters." : "No pricing rules configured."}</p>
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
            {pricingSortColumns.map(({ key, label }) => {
              const active = options.pricingSort === key;
              const Icon = active ? options.pricingDir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
              return <th key={key} scope="col" className="px-3 py-3" aria-sort={active ? options.pricingDir === "asc" ? "ascending" : "descending" : "none"}>
                <button type="button" onClick={() => sort(key)} className="inline-flex items-center gap-1.5 rounded-control transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                  {label}<Icon aria-hidden="true" size={14} />
                </button>
              </th>;
            })}
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
    {editing && createPortal(<ModalDialog ref={dialogRef} active={panelActive} aria-labelledby="pricing-dialog-title"
      onClose={() => { if (panelActive) close(); }} onCancel={(event) => { if (pendingRef.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto w-[calc(100%-1.5rem)] max-w-3xl rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50 sm:w-[calc(100%-2rem)]">
      <div className="p-4 sm:p-6">
        <div className="mb-5"><DialogHeader titleId="pricing-dialog-title" title={editing.rule ? "Edit pricing" : "Add pricing"}
          disabled={pending} onClose={() => dialogRef.current?.close()} /></div>

        <PricingRuleForm key={editing.rule?.rule_set_id ?? "new"} location={location} courts={courts} rule={editing.rule} openingHours={openingHours} schedules={schedules} today={localToday(location.timezone, new Date())}
          pending={pending} fieldErrors={fieldErrors} onSave={(input) => void mutate(() => savePricingRuleAction(input))}
          onEdit={() => {  setFieldErrors({}); }}
          onRemove={editing.rule ? (trigger) => { removeTriggerRef.current = trigger; setRemoving(true); } : undefined} />
        <ConfirmationDialog open={panelActive && removing && Boolean(editing.rule)} title="Remove pricing rule?"
          message={editing.rule ? `Pricing for ${courts.filter((court) => editing.rule?.court_ids.includes(court.id)).map((court) => court.name).join(", ")} on ${formatWeekdays(editing.rule.weekdays)} will no longer apply.` : ""}
          confirmLabel="Remove rule" pending={pending} returnFocusRef={removeTriggerRef}
          onClose={() => { if (!pendingRef.current) { setRemoving(false); } }}
          onConfirm={() => { const rule = editing.rule; if (rule) void mutate(() => removePricingRuleAction({ rule_set_id: rule.rule_set_id, location_id: location.id, revision: rule.revision })); }} />
      </div>
    </ModalDialog>, document.body)}
  </section>;
}
