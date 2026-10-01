"use client";

import { useId, useRef, useState, useTransition } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/input";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { useEditableFormBaseline } from "@/components/use-editable-form-baseline";
import type { CoverageMutationResult, CoveragePeriod } from "@/lib/courts/coverage-validation";
import { saveCoverageAction, removeCoverageAction } from "./actions";

const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
}).format(new Date(`${date}T00:00:00Z`));

export function CoveragePeriods({ courtId, courtName, periods }: { courtId: string; courtName?: string; periods: CoveragePeriod[] }) {
  const prefix = useId();
  const [editing, setEditing] = useState<CoveragePeriod | "new" | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<CoveragePeriod | null>(null);
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const { attach, dirty, sync, reset } = useEditableFormBaseline(["starts_on", "ends_on"]);

  function mutate(operation: () => Promise<CoverageMutationResult>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setError(""); setFieldErrors({});
    startTransition(async () => {
      try {
        const result = await operation();
        if (result.ok) { setEditing(null); setRemoving(null); reset(); }
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
          <Button type="button" variant="subtle" size="icon" aria-label="Edit period" title="Edit period" disabled={pending} onClick={() => { reset(); setEditing(period); setError(""); setFieldErrors({}); }}><Pencil size={16} aria-hidden="true" /></Button>
          <Button type="button" variant="destructive" size="icon" aria-label="Remove period" title="Remove period" disabled={pending} onClick={(event) => { removeTriggerRef.current = event.currentTarget; setError(""); setRemoving(period); }}><Trash2 size={16} aria-hidden="true" /></Button>
        </div>
      </li>)}
    </ul>
    {error && !removing && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    <ConfirmationDialog open={removing !== null} title={`Remove coverage period${courtName ? ` from ${courtName}` : ""}?`}
      message={removing ? `Coverage from ${dateLabel(removing.starts_on)} to ${dateLabel(removing.ends_on)} will no longer apply to ${courtName ?? "this court"}.` : ""}
      confirmLabel="Remove period" pending={pending} error={error} returnFocusRef={removeTriggerRef}
      onClose={() => { if (!pendingRef.current) { setRemoving(null); setError(""); } }}
      onConfirm={() => { if (removing) mutate(() => removeCoverageAction({ id: removing.id, court_id: courtId })); }} />
    {editing ? <form key={editing === "new" ? "new" : editing.id} ref={attach} onInput={sync} onChange={sync} className="mt-3" onSubmit={(event) => {
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
        <Button type="submit" variant="primary" size="small" fullWidth={false} disabled={pending || (editing !== "new" && !dirty)} aria-busy={pending}>{pending ? "Saving…" : "Save period"}</Button>
        <Button type="button" variant="secondary" size="small" onClick={() => { reset(); setEditing(null); setError(""); setFieldErrors({}); }}>Cancel</Button>
      </fieldset>
    </form> : <Button type="button" variant="subtle" size="small" className="mt-1 gap-1" aria-label="Add coverage period" disabled={pending} onClick={() => { reset(); setEditing("new"); setError(""); setFieldErrors({}); }}><Plus size={14} aria-hidden="true" /> Add period</Button>}
  </section>;
}
