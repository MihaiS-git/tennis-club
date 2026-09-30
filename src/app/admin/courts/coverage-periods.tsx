"use client";

import { useId, useRef, useState, useTransition } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/input";
import type { CoverageMutationResult, CoveragePeriod } from "@/lib/courts/coverage-validation";
import { saveCoverageAction, removeCoverageAction } from "./actions";

const buttonClass = "min-h-9 rounded-control border border-border-strong px-3 py-2 text-sm font-semibold text-primary disabled:opacity-60";
const iconButtonClass = "inline-flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60";
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
}).format(new Date(`${date}T00:00:00Z`));

export function CoveragePeriods({ courtId, periods }: { courtId: string; periods: CoveragePeriod[] }) {
  const prefix = useId();
  const [editing, setEditing] = useState<CoveragePeriod | "new" | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(false);

  function mutate(operation: () => Promise<CoverageMutationResult>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setError(""); setFieldErrors({});
    startTransition(async () => {
      try {
        const result = await operation();
        if (result.ok) setEditing(null);
        else if (result.reason === "invalid-input") {
          setError("Check the coverage dates."); setFieldErrors(result.fieldErrors);
        } else setError(result.reason === "overlap" ? "These dates overlap an existing coverage period."
          : result.reason === "outdoor-only" ? "Coverage periods are only available for outdoor courts."
            : "This court or coverage period no longer exists.");
      } catch { setError("Unable to change coverage period. Please try again."); }
      finally { pendingRef.current = false; }
    });
  }

  return <section aria-labelledby={`${prefix}-heading`} className="mt-4 border-t border-border pt-3 lg:mt-0 lg:border-t-0 lg:pt-0">
    <h3 id={`${prefix}-heading`} className="text-sm font-semibold text-muted-foreground">Coverage periods</h3>
    {periods.length === 0 && <p className="mt-1 text-sm text-muted-foreground">No coverage periods.</p>}
    <ul className="mt-1 divide-y divide-border">
      {periods.map((period) => <li key={period.id} className="flex items-center justify-between gap-2 py-1 text-sm">
        <span className="min-w-0">{dateLabel(period.starts_on)} — {dateLabel(period.ends_on)}</span>
        <div className="flex shrink-0 gap-1">
          <button type="button" className={`${iconButtonClass} hover:text-primary`} aria-label="Edit period" title="Edit period" disabled={pending} onClick={() => { setEditing(period); setError(""); setFieldErrors({}); }}><Pencil size={16} aria-hidden="true" /></button>
          <button type="button" className={`${iconButtonClass} hover:text-danger`} aria-label="Remove period" title="Remove period" disabled={pending} onClick={() => mutate(() => removeCoverageAction({ id: period.id, court_id: courtId }))}><Trash2 size={16} aria-hidden="true" /></button>
        </div>
      </li>)}
    </ul>
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {editing ? <form key={editing === "new" ? "new" : editing.id} className="mt-3" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      mutate(() => saveCoverageAction({ ...(editing === "new" ? {} : { id: editing.id }), court_id: courtId,
        dates: { starts_on: data.get("starts_on"), ends_on: data.get("ends_on") } }));
    }}>
      <fieldset disabled={pending} className="flex flex-wrap items-end gap-3">
        {(["starts_on", "ends_on"] as const).map((field) => <div key={field}>
          <label htmlFor={`${prefix}-${field}`} className="mb-1 block text-sm">{field === "starts_on" ? "Start date" : "End date"}</label>
          <Input id={`${prefix}-${field}`} name={field} type="date" required defaultValue={editing === "new" ? "" : editing[field]}
            aria-invalid={Boolean(fieldErrors[field])} aria-describedby={fieldErrors[field] ? `${prefix}-${field}-error` : undefined} />
          {fieldErrors[field] && <p id={`${prefix}-${field}-error`} className="mt-1 text-sm text-danger">{fieldErrors[field]}</p>}
        </div>)}
        <button type="submit" className={buttonClass} aria-busy={pending}>{pending ? "Saving…" : "Save period"}</button>
        <button type="button" className={buttonClass} onClick={() => { setEditing(null); setError(""); setFieldErrors({}); }}>Cancel</button>
      </fieldset>
    </form> : <button type="button" className="mt-1 inline-flex items-center gap-1 rounded-control px-1 py-1 text-xs font-medium text-muted-foreground hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60" aria-label="Add coverage period" disabled={pending} onClick={() => { setEditing("new"); setError(""); setFieldErrors({}); }}><Plus size={14} aria-hidden="true" /> Add period</button>}
  </section>;
}
