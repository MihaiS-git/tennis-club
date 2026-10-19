"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { DialogHeader } from "@/components/dialog-layout";
import { Input } from "@/components/input";
import { ModalDialog } from "@/components/modal-dialog";
import { useEditableFormBaseline } from "@/components/use-editable-form-baseline";
import type { AdminCoachingProgram } from "@/lib/coaching/admin";
import {
  coachingProgramFieldsSchema, coachingProgramTypeLabels, coachingProgramTypes, formatCoachingDuration,
} from "@/lib/coaching/validation";
import { saveCoachingProgramAction } from "../actions";
import { coachingFailureMessages, formText, hintClass, labelClass, optionalNumber, selectClass, textareaClass, useFieldErrors } from "../coaching-form";

const presetDurations = [30, 45, 60, 75, 90, 120];
const editableFields = ["name", "description", "program_type", "duration", "other_durations", "min_participants", "max_participants", "court_rental_included", "is_active"];

function programFields(form: HTMLFormElement) {
  const data = new FormData(form);
  const other = formText(data, "other_durations").split(",").map((value) => value.trim()).filter(Boolean).map(Number);
  const durations = [...new Set([...data.getAll("duration").map(Number), ...other])].sort((a, b) => a - b);
  return {
    name: formText(data, "name"), description: formText(data, "description"), program_type: formText(data, "program_type"),
    durations, min_participants: optionalNumber(formText(data, "min_participants")),
    max_participants: optionalNumber(formText(data, "max_participants")),
    court_rental_included: formText(data, "court_rental_included") === "true", is_active: formText(data, "is_active") === "true",
  };
}

export function ProgramDialog({ program, open: controlledOpen, onOpenChange }: {
  program?: AdminCoachingProgram; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, setPending] = useState(false);
  const { setFieldErrors, errorProps, fieldError } = useFieldErrors(prefix);
  const { attach, dirty, valid, sync, submitted, commit } = useEditableFormBaseline(editableFields, undefined,
    (form) => coachingProgramFieldsSchema.safeParse(programFields(form)).success);
  const durations = program?.durations ?? [60];
  const choices = [...new Set([...presetDurations, ...durations])].sort((a, b) => a - b);

  async function submit(form: HTMLFormElement) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setFieldErrors({});
    const saved = submitted(form);
    const notification = toast.loading("Saving program…");
    try {
      const result = await saveCoachingProgramAction({ ...(program ? { id: program.id } : {}), fields: programFields(form) });
      if (result.ok) {
        commit(saved);
        toast.success(program ? "Program updated." : "Program created.", { id: notification });
        dialogRef.current?.close();
        router.refresh();
      } else if (result.reason === "invalid-input") {
        toast.dismiss(notification); setFieldErrors(result.fieldErrors);
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
      onClick={() => { setFieldErrors({}); setOpen(true); }}>Create program</Button>}
    <ModalDialog ref={dialogRef} active={open} aria-labelledby={`${prefix}-title`}
      onClose={() => setOpen(false)} onCancel={(event) => { if (pendingRef.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50">
      {open && <div className="p-5 sm:p-6">
        <div className="mb-5"><DialogHeader titleId={`${prefix}-title`} title={program ? "Edit program" : "Create program"}
          disabled={pending} onClose={() => dialogRef.current?.close()} /></div>
        <form ref={attach} onInput={sync} onChange={sync} onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
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
                {choices.map((minutes) => <label key={minutes} className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-border px-3 text-sm has-checked:border-primary has-checked:bg-surface-muted">
                  <input type="checkbox" name="duration" value={minutes} defaultChecked={durations.includes(minutes)} className="accent-primary" />
                  {formatCoachingDuration(minutes)}
                </label>)}
              </div>
              <label htmlFor={`${prefix}-other_durations`} className="mt-3 mb-1.5 block text-sm">Other durations (minutes, comma-separated)</label>
              <Input id={`${prefix}-other_durations`} name="other_durations" inputMode="numeric" placeholder="e.g. 105" {...errorProps("durations")} />
              <p id={`${prefix}-durations-hint`} className={hintClass}>15–480 minutes in 5-minute steps. Prices are set per duration.</p>
              {fieldError("durations")}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={`${prefix}-min_participants`} className={labelClass}>Minimum players</label>
                <Input id={`${prefix}-min_participants`} name="min_participants" type="number" min={1} max={100} placeholder="Not set"
                  defaultValue={program?.min_participants ?? ""} {...errorProps("min_participants")} />
                {fieldError("min_participants")}
              </div>
              <div>
                <label htmlFor={`${prefix}-max_participants`} className={labelClass}>Maximum players</label>
                <Input id={`${prefix}-max_participants`} name="max_participants" type="number" min={1} max={100} placeholder="Not set"
                  defaultValue={program?.max_participants ?? ""} {...errorProps("max_participants")} />
                {fieldError("max_participants")}
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
            <div className="flex justify-end border-t border-border pt-4">
              <Button type="submit" fullWidth={false} disabled={pending || !valid || (program ? !dirty : false)} aria-busy={pending}>
                {pending ? "Saving…" : "Save program"}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>}
    </ModalDialog>
  </>;
}
