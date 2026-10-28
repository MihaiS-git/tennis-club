"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { DialogHeader } from "@/components/dialog-layout";
import { Input } from "@/components/input";
import { ModalDialog } from "@/components/modal-dialog";
import { useEditableFormBaseline } from "@/components/use-editable-form-baseline";
import type { AdminCoach, AdminCoachAccount, AdminCoachingLocation, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";
import { coachProfileFieldsSchema, formatCoachingDuration, formatPlayers, parseTextList } from "@/lib/coaching/validation";
import { formatMoney } from "@/lib/pricing/money";
import { saveCoachProfileAction } from "../actions";
import { coachingFailureMessages, formText, hintClass, labelClass, selectClass, textareaClass, useFieldErrors } from "../coaching-form";

const editableFields = ["user_id", "display_name", "bio", "qualifications", "specialties", "languages", "location_ids", "program_ids", "is_public"];
const choiceClass = "flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-border px-3 py-2 text-sm has-checked:border-primary has-checked:bg-surface-muted";

function coachFields(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    display_name: formText(data, "display_name"), bio: formText(data, "bio"), qualifications: formText(data, "qualifications"),
    specialties: parseTextList(formText(data, "specialties")), languages: parseTextList(formText(data, "languages")),
    location_ids: data.getAll("location_ids").map(String), program_ids: data.getAll("program_ids").map(String),
    is_public: formText(data, "is_public") === "true",
  };
}

export function CoachDialog({ coach, account, accounts = [], locations, programs, prices = [], open: controlledOpen, onOpenChange }: {
  coach?: AdminCoach; account?: AdminCoachAccount; accounts?: AdminCoachAccount[]; locations: AdminCoachingLocation[]; programs: AdminCoachingProgram[];
  // This coach's own price overrides, shown read-only: coaches manage them under My prices.
  prices?: AdminCoachingPrice[];
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, setPending] = useState(false);
  const { setFieldErrors, errorProps, fieldError } = useFieldErrors(prefix);
  const { attach, dirty, valid, sync, submitted, commit } = useEditableFormBaseline(editableFields, undefined,
    (form) => (coach !== undefined || account !== undefined || formText(new FormData(form), "user_id") !== "") && coachProfileFieldsSchema.safeParse(coachFields(form)).success);
  // Archived locations stay listed only while this coach is still assigned to them.
  const locationChoices = [...locations, ...(coach?.location_ids ?? []).filter((id) => !locations.some((location) => location.id === id))
    .map((id) => ({ id, name: "Archived location", currency: "EUR" as const, is_active: false }))];
  const overrides = coach ? prices.filter((price) => price.coach_user_id === coach.user_id) : [];
  // Removing a program assignment deletes the coach's overrides for it on save; state that first.
  const [programIds, setProgramIds] = useState<readonly string[]>(coach?.program_ids ?? []);
  const dropped = overrides.filter((price) => !programIds.includes(price.program_id));
  function onFormChange(event: React.FormEvent<HTMLFormElement>) {
    sync();
    setProgramIds(coachFields(event.currentTarget).program_ids);
  }

  async function submit(form: HTMLFormElement) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setFieldErrors({});
    const saved = submitted(form);
    const userId = coach?.user_id ?? account?.id ?? formText(new FormData(form), "user_id");
    const notification = toast.loading("Saving coach…");
    try {
      const result = await saveCoachProfileAction({ user_id: userId, create: !coach, fields: coachFields(form) });
      if (result.ok) {
        commit(saved);
        toast.success(coach ? "Coach updated." : "Coach added.", { id: notification });
        dialogRef.current?.close();
        router.refresh();
      } else if (result.reason === "invalid-input") {
        toast.dismiss(notification); setFieldErrors(result.fieldErrors);
      } else if (result.reason === "has-availability") {
        toast.dismiss(notification);
        setFieldErrors({ location_ids: "This coach has availability at a removed location. Remove that availability first." });
      } else if (result.reason === "not-eligible") {
        toast.dismiss(notification);
        setFieldErrors(coach ? { is_public: coachingFailureMessages["not-eligible"] } : { user_id: coachingFailureMessages["not-eligible"] });
      } else if (result.reason === "invalid-location") {
        toast.dismiss(notification); setFieldErrors({ location_ids: "A selected location is no longer available." });
      } else if (result.reason === "invalid-program") {
        toast.dismiss(notification); setFieldErrors({ program_ids: "A selected program no longer exists." });
      } else {
        toast.error(coachingFailureMessages[result.reason], { id: notification });
      }
    } catch {
      toast.error("Unable to save coach. Please try again.", { id: notification });
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }

  return <>
    {!coach && controlledOpen === undefined && <Button type="button" variant="secondary" size="small" fullWidth={false}
      onClick={() => { setFieldErrors({}); setOpen(true); }}>Add coach</Button>}
    <ModalDialog ref={dialogRef} active={open} aria-labelledby={`${prefix}-title`}
      onClose={() => setOpen(false)} onCancel={(event) => { if (pendingRef.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50">
      {open && <div className="p-5 sm:p-6">
        <div className="mb-5"><DialogHeader titleId={`${prefix}-title`} title={coach ? "Edit coach" : "Add coach"}
          disabled={pending} onClose={() => dialogRef.current?.close()} /></div>
        <form ref={attach} onInput={onFormChange} onChange={onFormChange} onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
          <fieldset disabled={pending} className="space-y-4">
            {coach || account ? <p className="text-sm text-muted-foreground">Account: <span className="text-foreground">{coach?.email ?? account?.email}</span>. The email is never shown publicly.</p> : <div>
              <label htmlFor={`${prefix}-user_id`} className={labelClass}>Coach account</label>
              <select id={`${prefix}-user_id`} name="user_id" required className={selectClass} defaultValue="" {...errorProps("user_id")}
                onChange={(event) => {
                  const account = accounts.find((item) => item.id === event.target.value);
                  if (account?.suggested_name && nameRef.current && !nameRef.current.value.trim()) nameRef.current.value = account.suggested_name;
                }}>
                <option value="" disabled>Select an account</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.suggested_name ? `${account.suggested_name} · ` : ""}{account.email}</option>)}
              </select>
              <p className={hintClass}>Active accounts with the Coach role and no coaching profile. Assign the role under Users.</p>
              {fieldError("user_id")}
            </div>}
            <div>
              <label htmlFor={`${prefix}-display_name`} className={labelClass}>Public name</label>
              <Input ref={nameRef} id={`${prefix}-display_name`} name="display_name" required maxLength={100} defaultValue={coach?.display_name ?? account?.suggested_name ?? ""} {...errorProps("display_name")} />
              {fieldError("display_name")}
            </div>
            <div>
              <label htmlFor={`${prefix}-bio`} className={labelClass}>Biography</label>
              <textarea id={`${prefix}-bio`} name="bio" rows={4} maxLength={2000} className={textareaClass} defaultValue={coach?.bio ?? ""} {...errorProps("bio")} />
              {fieldError("bio")}
            </div>
            <div>
              <label htmlFor={`${prefix}-qualifications`} className={labelClass}>Qualifications</label>
              <textarea id={`${prefix}-qualifications`} name="qualifications" rows={2} maxLength={1000} className={textareaClass}
                defaultValue={coach?.qualifications ?? ""} {...errorProps("qualifications")} />
              {fieldError("qualifications")}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={`${prefix}-specialties`} className={labelClass}>Specialties</label>
                <Input id={`${prefix}-specialties`} name="specialties" defaultValue={coach?.specialties.join(", ") ?? ""} {...errorProps("specialties")} />
                <p className={hintClass}>Comma-separated, up to 12.</p>{fieldError("specialties")}
              </div>
              <div>
                <label htmlFor={`${prefix}-languages`} className={labelClass}>Languages</label>
                <Input id={`${prefix}-languages`} name="languages" defaultValue={coach?.languages.join(", ") ?? ""} {...errorProps("languages")} />
                <p className={hintClass}>Comma-separated, up to 12.</p>{fieldError("languages")}
              </div>
            </div>
            <fieldset>
              <legend className={labelClass}>Locations</legend>
              {locationChoices.length ? <div className="grid gap-2 sm:grid-cols-2">
                {locationChoices.map((location) => <label key={location.id} className={choiceClass}>
                  <input type="checkbox" name="location_ids" value={location.id} defaultChecked={coach?.location_ids.includes(location.id)} className="accent-primary" />
                  {location.name}{location.is_active ? "" : " (inactive)"}
                </label>)}
              </div> : <p className="text-sm text-muted-foreground">No locations yet.</p>}
              {fieldError("location_ids")}
            </fieldset>
            <fieldset>
              <legend className={labelClass}>Programs</legend>
              {programs.length ? <div className="grid gap-2 sm:grid-cols-2">
                {programs.map((program) => <label key={program.id} className={choiceClass}>
                  <input type="checkbox" name="program_ids" value={program.id} defaultChecked={coach?.program_ids.includes(program.id)} className="accent-primary" />
                  {program.name}{program.is_active ? "" : " (inactive)"}
                </label>)}
              </div> : <p className="text-sm text-muted-foreground">No programs yet. Create programs first.</p>}
              {dropped.length > 0 && <p role="status" className="mt-2 rounded-control border border-warning bg-warning-background px-3 py-2 text-sm text-foreground">
                Saving removes {dropped.length} individual {dropped.length === 1 ? "price" : "prices"} this coach set for{" "}
                {programNames([...new Set(dropped.map((price) => price.program_id))], programs)}. Existing bookings keep their agreed prices.
              </p>}
              {fieldError("program_ids")}
            </fieldset>
            {coach && <IndividualPrices prefix={prefix} prices={overrides} programs={programs} removedProgramIds={new Set(dropped.map((price) => price.program_id))} />}
            <div>
              <label htmlFor={`${prefix}-is_public`} className={labelClass}>Public visibility</label>
              <select id={`${prefix}-is_public`} name="is_public" className={selectClass} defaultValue={String(coach?.is_public ?? false)} {...errorProps("is_public")}>
                <option value="false">Hidden</option><option value="true">Shown on the Coaching page</option>
              </select>{fieldError("is_public")}
            </div>
            {fieldError("form")}
            <div className="flex justify-end border-t border-border pt-4">
              <Button type="submit" fullWidth={false} disabled={pending || !valid || (coach ? !dirty : false)} aria-busy={pending}>
                {pending ? "Saving…" : "Save coach"}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>}
    </ModalDialog>
  </>;
}

function programNames(ids: readonly string[], programs: readonly AdminCoachingProgram[]) {
  return ids.map((id) => programs.find((program) => program.id === id)?.name ?? "Unavailable program").join(", ");
}

// Read-only: grouped by program, then ordered by duration, number of players and currency.
function IndividualPrices({ prefix, prices, programs, removedProgramIds }: {
  prefix: string; prices: readonly AdminCoachingPrice[]; programs: readonly AdminCoachingProgram[]; removedProgramIds: ReadonlySet<string>;
}) {
  const programIds = [...new Set(prices.map((price) => price.program_id))]
    .sort((a, b) => programNames([a], programs).localeCompare(programNames([b], programs)) || a.localeCompare(b));
  return <section aria-labelledby={`${prefix}-individual-prices`}>
    <h3 id={`${prefix}-individual-prices`} className={labelClass}>Individual prices</h3>
    <p className="mb-3 text-xs text-muted-foreground">
      Lesson prices/person this coach set for their own lessons, replacing the club price. Coaches manage them under My prices; they cannot be changed here.
    </p>
    {!programIds.length ? <p className="text-sm text-muted-foreground">No individual prices. This coach&rsquo;s lessons use the club prices.</p>
      : <div className="space-y-3">
        {programIds.map((programId) => {
          const name = programNames([programId], programs);
          const rows = prices.filter((price) => price.program_id === programId).sort((a, b) => a.duration_minutes - b.duration_minutes
            || a.participant_count - b.participant_count || a.currency.localeCompare(b.currency));
          return <div key={programId} className="overflow-x-auto rounded-control border border-border">
            <table className="w-full text-left text-sm" aria-label={`Individual prices for ${name}`}>
              <caption className="border-b border-border bg-surface-muted px-3 py-2 text-left font-semibold text-foreground">
                {name}{removedProgramIds.has(programId) && <span className="ml-2 text-xs font-normal text-muted-foreground">Removed when you save</span>}
              </caption>
              <thead className="text-xs font-semibold text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2">Duration</th>
                  <th scope="col" className="px-3 py-2">Players</th>
                  <th scope="col" className="px-3 py-2">Currency</th>
                  <th scope="col" className="px-3 py-2 text-right">Lesson price/person</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((price) => <tr key={price.id}>
                  <td className="whitespace-nowrap px-3 py-2">{formatCoachingDuration(price.duration_minutes)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{formatPlayers(price.participant_count)}</td>
                  <td className="px-3 py-2">{price.currency}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatMoney(price.amount_minor, price.currency)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>;
        })}
      </div>}
  </section>;
}
