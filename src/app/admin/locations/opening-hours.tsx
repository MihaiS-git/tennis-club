"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/input";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import {
  groupedWeeklySchedule, minuteToTime, openingHoursScheduleKey, timeToMinute, weeklyHoursMutationSchema,
  weekdayGroupLabel, weekdays, scheduleStatus, planOpeningHoursPeriod,
  type OpeningInterval, type OpeningHoursMutationResult, type OpeningHoursSchedule,
} from "@/lib/admin/opening-hours-validation";
import { useProfileFormDirty } from "@/app/profile/unsaved-changes";
import { useLocationPanelActive } from "./location-workspace";
import { mutateOpeningHoursAction } from "./opening-hours-actions";

type DraftRow = { key: string; weekdays: number[]; opens_at: string; closes_at: string };
type Draft = { starts_on: string; ends_on: string; rows: DraftRow[] };
type Selection = { schedule: OpeningHoursSchedule | null; history: boolean };
const emptyDraft = (): Draft => ({ starts_on: "", ends_on: "", rows: [] });
const subscribeToHydration = () => () => {};
const suggestions = Array.from({ length: 48 }, (_, index) => minuteToTime(index * 30));
const openingOptions = suggestions.map((time) => ({ value: time, label: time }));
const closingOptions = [...openingOptions, { value: "24:00", label: "24:00" }];
const draftSnapshot = (draft: Draft) => JSON.stringify({ ...draft, rows: draft.rows.map(({ weekdays, opens_at, closes_at }) => ({
  weekdays: [...weekdays].sort((a, b) => a - b), opens_at, closes_at,
})) });
const scheduleLabel = (schedule: OpeningHoursSchedule, today: string) =>
  `${scheduleStatus(schedule, today)} · ${schedule.starts_on} → ${schedule.ends_on ?? "Unlimited"}`;

export function OpeningHours({ locationId, intervals, schedules = [], today = "", onUpdated }: {
  locationId: string; intervals: OpeningInterval[]; schedules?: OpeningHoursSchedule[]; today?: string;
  onUpdated: (intervals: OpeningInterval[], schedules?: OpeningHoursSchedule[]) => void;
}) {
  const prefix = useId();
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const panelActive = useLocationPanelActive();
  const router = useRouter();
  const pendingRef = useRef(false);
  const nextKey = useRef(0);
  function scheduleDraft(schedule: OpeningHoursSchedule | null, hours: OpeningInterval[]): Draft {
    if (!schedule) return emptyDraft();
    return { starts_on: schedule.starts_on, ends_on: schedule.ends_on ?? "",
      rows: groupedWeeklySchedule(locationId, hours.filter((h) => h.schedule_id === schedule.id)).flatMap((group) =>
        group.intervals.map((interval) => ({ key: interval.ids.join("-"), weekdays: [...group.weekdays],
          opens_at: minuteToTime(interval.opens_at_minute), closes_at: minuteToTime(interval.closes_at_minute) }))) };
  }
  const defaultSchedule = () => schedules.find((s) => scheduleStatus(s, today) === "Current")
    ?? schedules.find((s) => scheduleStatus(s, today) === "Scheduled") ?? null;
  const [selectedSchedule, setSelectedSchedule] = useState(defaultSchedule);
  const [creating, setCreating] = useState(!selectedSchedule);
  const [history, setHistory] = useState(false);
  const [draft, setDraft] = useState(() => scheduleDraft(selectedSchedule, intervals));
  const [baseline, setBaseline] = useState(() => draftSnapshot(draft));
  const [draftSchedules, setDraftSchedules] = useState(schedules);
  const [savedHours, setSavedHours] = useState(intervals);
  const [pending, setPending] = useState(false);
  const [switching, setSwitching] = useState<Selection | null>(null);
  const [openDays, setOpenDays] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const dirty = draftSnapshot(draft) !== baseline;
  useProfileFormDirty("Opening hours", dirty);
  const source = JSON.stringify({ intervals, schedules });
  const [loadedSource, setLoadedSource] = useState(source);
  if (loadedSource !== source) {
    setLoadedSource(source);
    // Dirty drafts retain their original hours, period preview and revision.
    if (!dirty && !pending) {
      const saved = schedules.find((s) => s.id === selectedSchedule?.id) ?? defaultSchedule();
      const next = scheduleDraft(saved, intervals);
      setSelectedSchedule(saved); setCreating(!saved); setHistory(saved ? scheduleStatus(saved, today) === "History" : false);
      setDraft(next); setBaseline(draftSnapshot(next)); setDraftSchedules(schedules); setSavedHours(intervals); setOpenDays(null);
    }
  }
  const readOnly = !creating && selectedSchedule !== null && scheduleStatus(selectedSchedule, today) === "History";
  function selectSchedule({ schedule: selection, history: nextHistory }: Selection) {
    const schedule = schedules.find((s) => s.id === selection?.id) ?? selection;
    const next = scheduleDraft(schedule ?? selectedSchedule ?? defaultSchedule(), intervals);
    if (!schedule) { next.starts_on = ""; next.ends_on = ""; }
    setSelectedSchedule(schedule); setCreating(!schedule && !nextHistory); setHistory(nextHistory); setDraft(next);
    setBaseline(draftSnapshot(next)); setDraftSchedules(schedules); setSavedHours(intervals); setFieldErrors({}); setSwitching(null); setOpenDays(null);
  }
  function requestSelection(selection: Selection) {
    if (dirty) setSwitching(selection); else selectSchedule(selection);
  }
  function updateRow(key: string, changes: Partial<Pick<DraftRow, "weekdays" | "opens_at" | "closes_at">>) {
    setDraft((current) => ({ ...current, rows: current.rows.map((row) => row.key === key ? { ...row, ...changes } : row) })); setFieldErrors({});
  }
  const selectedIntervals = savedHours.filter((h) => h.schedule_id === selectedSchedule?.id);
  const payload = {
    location_id: locationId, operation: creating ? "create" : "update",
    replace_ids: creating ? [] : selectedIntervals.map((h) => h.id),
    rows: draft.rows.map(({ weekdays, opens_at, closes_at }) => ({ weekdays, opens_at, closes_at })),
    starts_on: draft.starts_on, ends_on: draft.ends_on,
    ...(!creating && selectedSchedule ? { schedule_id: selectedSchedule.id, revision: selectedSchedule.revision } : {}),
  };
  const validation = weeklyHoursMutationSchema.safeParse(payload);
  const period = validation.success ? planOpeningHoursPeriod(
    draftSchedules.filter((s) => creating || s.id !== selectedSchedule?.id), draft.starts_on, draft.ends_on || null, today, creating,
  ) : null;
  const changedHours = validation.success && openingHoursScheduleKey(selectedIntervals) !== openingHoursScheduleKey(
    draft.rows.flatMap((row) => row.weekdays.map((weekday) => ({ weekday,
      opens_at_minute: timeToMinute(row.opens_at), closes_at_minute: timeToMinute(row.closes_at) }))));
  const changedDates = selectedSchedule ? draft.starts_on !== selectedSchedule.starts_on || (draft.ends_on || null) !== selectedSchedule.ends_on : true;
  const canSave = !readOnly && dirty && validation.success && period?.ok && (creating || changedHours || changedDates);
  const issues = !validation.success && dirty ? validation.error.issues : [];
  function fieldError(field: string, row?: number) {
    const issue = issues.find((issue) => row === undefined ? issue.path[0] === field
      : issue.path[0] === "rows" && issue.path[1] === row && issue.path[2] === field);
    return fieldErrors[field] ?? (issue ? `${row === undefined ? "" : `Interval ${row + 1}: `}${field === "starts_on" ? "Choose a valid start date." : issue.message}` : undefined);
  }
  const periodError = period && !period.ok && dirty
    ? "These dates overlap another schedule. Edit its validity dates explicitly; scheduled future policies cannot be adjusted automatically." : undefined;
  const startError = fieldError("starts_on") ?? periodError;
  const scheduleError = fieldErrors.form ?? fieldErrors.rows ?? issues.find((issue) => issue.path.length === 1 && issue.path[0] === "rows")?.message;

  async function save() {
    if (!canSave || !validation.success || validation.data.operation === "delete" || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setFieldErrors({}); setOpenDays(null);
    const notification = toast.loading("Saving opening hours…");
    try {
      // Validate the whole table, then use the existing replacement command to
      // preserve the identities and timestamps of every unchanged interval.
      const matches = (saved: OpeningInterval, row: DraftRow, day: number) => saved.weekday === day
        && minuteToTime(saved.opens_at_minute) === row.opens_at && minuteToTime(saved.closes_at_minute) === row.closes_at;
      const replaceIds = selectedIntervals.filter((saved) => !draft.rows.some((row) => row.weekdays.some((day) => matches(saved, row, day)))).map((saved) => saved.id);
      const rows = draft.rows.map((row) => ({ opens_at: row.opens_at, closes_at: row.closes_at,
        weekdays: row.weekdays.filter((day) => !selectedIntervals.some((saved) => matches(saved, row, day))) })).filter((row) => row.weekdays.length);
      const result: OpeningHoursMutationResult = await mutateOpeningHoursAction({ ...validation.data, replace_ids: replaceIds, rows,
        ...(creating && period?.ok ? { adjustment: period.adjustment ? { id: period.adjustment.id, revision: period.adjustment.revision } : null } : {}),
      });
      if (result.ok) {
        onUpdated(result.intervals, result.schedules);
        const saved = result.schedules?.find((s) => s.id === result.scheduleId) ?? selectedSchedule;
        const next = scheduleDraft(saved, result.intervals);
        setSelectedSchedule(saved); setCreating(!saved); setHistory(saved ? scheduleStatus(saved, today) === "History" : false);
        setDraft(next); setBaseline(draftSnapshot(next)); setDraftSchedules(result.schedules ?? schedules); setSavedHours(result.intervals);
        toast.success(result.pricingAdjusted ? "Opening hours updated. Pricing adjusted automatically." : "Opening hours updated.", { id: notification });
        if (result.missingPricing) toast.warning("Some newly opened hours need pricing configuration for one or more courts.");
        router.refresh();
      } else if (result.reason === "invalid-input") {
        toast.dismiss(notification); setFieldErrors(result.fieldErrors);
      } else if (result.reason === "overlap") {
        toast.error(`${result.weekdays.map((day) => weekdays[day]).join(", ") || "Selected days"} conflict with existing opening hours. Check the intervals; no changes were saved.`, { id: notification });
      } else if (result.reason === "period-overlap") {
        toast.error("These dates overlap another schedule. Edit its validity dates explicitly; scheduled future policies cannot be adjusted automatically.", { id: notification });
      } else if (result.reason === "stale") {
        toast.error(creating ? "Opening hours have changed. Cancel this draft and create it again to review the latest schedules."
          : "This schedule has changed. Cancel edit to load its latest saved values.", { id: notification });
        router.refresh();
      } else if (result.reason === "archived") toast.error("Restore this location before changing its opening hours.", { id: notification });
      else if (result.reason === "unchanged") toast.info("These opening hours are already saved. No changes were made.", { id: notification });
      else toast.error("This location or schedule no longer exists. Refresh and try again.", { id: notification });
    } catch { toast.error("Unable to change opening hours. Please try again.", { id: notification }); }
    finally { pendingRef.current = false; setPending(false); }
  }

  const availableSchedules = schedules.filter((s) => (scheduleStatus(s, today) === "History") === history);
  return <section aria-labelledby={`${prefix}-heading`} className="min-w-0 text-sm">
    <h2 id={`${prefix}-heading`} className="mb-3 font-semibold text-foreground">Weekly schedule</h2>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs font-medium" htmlFor={`${prefix}-schedule`}>{history ? "Historical schedule" : "Current/Scheduled schedule"}
        <select id={`${prefix}-schedule`} aria-label={history ? "Historical schedule" : "Current/Scheduled schedule"}
          value={creating ? "" : selectedSchedule?.id ?? ""} disabled={pending || !hydrated}
          className="mt-1 min-h-10 w-full rounded-control border border-border bg-surface px-3 text-sm"
          onChange={(event) => { const schedule = schedules.find((s) => s.id === event.target.value); if (schedule) requestSelection({ schedule, history }); }}>
          {creating && <option value="">New schedule</option>}
          {availableSchedules.map((schedule) => <option key={schedule.id} value={schedule.id}>{scheduleLabel(schedule, today)}</option>)}
          {!creating && !availableSchedules.length && <option value="">No schedules</option>}
        </select>
      </label>
      <Button type="button" variant="secondary" size="small" disabled={pending || !hydrated || creating}
        onClick={() => requestSelection({ schedule: null, history: false })}>New schedule</Button>
      <Button type="button" variant="secondary" size="small" disabled={pending || !hydrated} aria-pressed={history}
        onClick={() => requestSelection({ history: !history, schedule: history ? defaultSchedule() : schedules.find((s) => scheduleStatus(s, today) === "History") ?? null })}>
        {history ? "Current/Scheduled" : "History"}
      </Button>
    </div>
    <ConfirmationDialog open={panelActive && switching !== null} title="Discard opening-hours changes?"
      message="Your unsaved changes will be discarded." confirmLabel="Discard changes"
      onClose={() => setSwitching(null)} onConfirm={() => { if (switching) selectSchedule(switching); }} />
    {history && !availableSchedules.length ? <p className="py-4 text-muted-foreground">No expired schedules.</p> :
    <form aria-label="Opening hours editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="mb-3 text-muted-foreground">{creating ? "New schedule" : selectedSchedule ? scheduleLabel(selectedSchedule, today) : "Not configured"}</p>
      {readOnly && <p className="mb-4 text-muted-foreground">Expired schedules are read-only.</p>}
      <fieldset disabled={pending || !hydrated || readOnly}>
        <legend className="sr-only">Weekly policy</legend>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div><label className="text-xs font-medium">Valid from<Input type="date" required value={draft.starts_on}
            aria-invalid={Boolean(startError)} aria-describedby={startError ? `${prefix}-start-error` : undefined}
            onChange={(event) => { setDraft((current) => ({ ...current, starts_on: event.target.value })); setFieldErrors({}); }} /></label>
            {startError && <p id={`${prefix}-start-error`} role="alert" className="mt-1 text-xs text-danger">{startError}</p>}</div>
          <div><label className="text-xs font-medium">Valid until (optional)<Input type="date" min={draft.starts_on} value={draft.ends_on}
            aria-invalid={Boolean(fieldError("ends_on"))} aria-describedby={fieldError("ends_on") ? `${prefix}-end-error` : undefined}
            onChange={(event) => { setDraft((current) => ({ ...current, ends_on: event.target.value })); setFieldErrors({}); }} /></label>
            {fieldError("ends_on") && <p id={`${prefix}-end-error`} role="alert" className="mt-1 text-xs text-danger">{fieldError("ends_on")}</p>}</div>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">{creating ? "This schedule replaces the entire weekly policy during its validity period. " : "Dates apply to the entire weekly policy. "}Validity boundaries are inclusive. Leave the end date empty for Unlimited.</p>
        {creating && period?.ok && period.adjustment && <p role="status" className="mb-4 text-sm text-muted-foreground">
          Saving will automatically end the current schedule ({period.adjustment.starts_on}) on {period.adjustment.ends_on}, the day before this schedule starts. Both schedules and their intervals will be preserved. Pricing will be reconciled automatically.
        </p>}
        <table aria-label="Weekly intervals" aria-describedby={scheduleError ? `${prefix}-schedule-error` : undefined} className="w-full table-fixed border-y border-border text-left">
          <thead><tr className="border-b border-border text-xs text-muted-foreground">
            <th scope="col" className="w-[34%] py-2 pr-2">Days</th><th scope="col" className="w-[25%] py-2 pr-2">Opens</th>
            <th scope="col" className="w-[25%] py-2 pr-2">Closes</th><th scope="col" className="py-2"><span className="sr-only sm:not-sr-only">Actions</span></th>
          </tr></thead>
          <tbody>{draft.rows.map((row, index) => <tr key={row.key} className="border-b border-border last:border-b-0">
            <td className="relative py-3 pr-2">
              <div onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpenDays((key) => key === row.key ? null : key); }}
                onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpenDays(null); event.currentTarget.querySelector("button")?.focus(); } }}>
                <Button type="button" variant="secondary" size="small" className="w-full justify-start whitespace-normal text-left"
                  aria-label={`Days for interval ${index + 1}: ${weekdayGroupLabel(row.weekdays) || "Select days"}`}
                  aria-expanded={openDays === row.key} aria-controls={openDays === row.key ? `${prefix}-days-${row.key}` : undefined}
                  aria-invalid={Boolean(fieldError("weekdays", index))} aria-describedby={fieldError("weekdays", index) ? `${prefix}-days-error-${row.key}` : undefined}
                  onClick={() => setOpenDays((key) => key === row.key ? null : row.key)}>{weekdayGroupLabel(row.weekdays) || "Select days"}</Button>
                {openDays === row.key && <div id={`${prefix}-days-${row.key}`} role="group" aria-label={`Weekdays for interval ${index + 1}`}
                  className="absolute left-0 z-40 mt-1 w-64 max-w-[calc(100vw-3rem)] rounded-control border border-border bg-surface p-3 shadow-floating">
                  <div className="mb-3 flex flex-wrap gap-1">
                    {([["Weekdays", [0, 1, 2, 3, 4]], ["Weekend", [5, 6]], ["All days", [0, 1, 2, 3, 4, 5, 6]]] as const).map(([label, days]) =>
                      <Button key={label} type="button" variant="subtle" size="small" onClick={() => updateRow(row.key, { weekdays: [...days] })}>{label}</Button>)}
                  </div>
                  <div className="grid grid-cols-2 gap-2">{weekdays.map((label, day) => <label key={label} className="inline-flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={row.weekdays.includes(day)} onChange={(event) => updateRow(row.key, { weekdays: event.target.checked
                      ? [...row.weekdays, day].sort((a, b) => a - b) : row.weekdays.filter((selected) => selected !== day) })} />{label}
                  </label>)}</div>
                  <Button type="button" variant="subtle" size="small" className="mt-2" onClick={(event) => { setOpenDays(null); event.currentTarget.closest("td")?.querySelector("button")?.focus(); }}>Done</Button>
                </div>}
              </div>
              {fieldError("weekdays", index) && <p id={`${prefix}-days-error-${row.key}`} role="alert" className="mt-1 text-xs text-danger">{fieldError("weekdays", index)}</p>}
            </td>
            {(["opens_at", "closes_at"] as const).map((field) => {
              const error = fieldError(field, index);
              return <td key={field} className="py-3 pr-2">
                <label htmlFor={`${prefix}-${field}-${row.key}`} className="sr-only">{field === "opens_at" ? "Opening time" : "Closing time"}</label>
                <SearchableCombobox id={`${prefix}-${field}-${row.key}`} placeholder="HH:mm" allowCustomValue disabled={pending || readOnly || !hydrated}
                  options={field === "opens_at" ? openingOptions : closingOptions} value={row[field]}
                  listLabel={field === "opens_at" ? "Opening time suggestions" : "Closing time suggestions"} emptyMessage="Enter a time as HH:mm."
                  onValueChange={(value) => updateRow(row.key, { [field]: value })} aria-invalid={Boolean(error)} aria-describedby={error ? `${prefix}-${field}-${row.key}-error` : undefined} />
                {error && <p id={`${prefix}-${field}-${row.key}-error`} role="alert" className="mt-1 text-xs text-danger">{error}</p>}
              </td>;
            })}
            <td className="py-3"><Button type="button" variant="destructive" size="small" aria-label={`Delete interval ${index + 1}`}
              onClick={() => { setDraft((current) => ({ ...current, rows: current.rows.filter((item) => item.key !== row.key) })); setOpenDays(null); setFieldErrors({}); }}>
              <Trash2 size={14} aria-hidden="true" /><span className="hidden sm:inline">Delete</span>
            </Button></td>
          </tr>)}</tbody>
        </table>
        {!draft.rows.length && <p className="py-3 text-muted-foreground">No intervals. Days without intervals are closed.</p>}
        {!readOnly && <Button type="button" variant="subtle" size="small" className="mt-2 gap-1" onClick={() => {
          const key = `new-${nextKey.current++}`;
          setDraft((current) => ({ ...current, rows: [...current.rows, { key, weekdays: [], opens_at: "", closes_at: "" }] })); setFieldErrors({});
        }}><Plus size={14} aria-hidden="true" />Add interval</Button>}
        {scheduleError && <p id={`${prefix}-schedule-error`} role="alert" className="mt-3 text-danger">{scheduleError}</p>}

        {!readOnly && <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" fullWidth={false} disabled={pending || !canSave} aria-busy={pending}>{pending ? "Saving…" : "Save changes"}</Button>
          {(dirty || creating) && <Button type="button" variant="secondary" onClick={() => selectSchedule({ schedule: creating ? defaultSchedule() : selectedSchedule, history: false })}>Cancel edit</Button>}
        </div>}
      </fieldset>
      <p className="mt-3 text-xs text-muted-foreground">Times are local to this location. Closing time may be 24:00.</p>
    </form>}
  </section>;
}
