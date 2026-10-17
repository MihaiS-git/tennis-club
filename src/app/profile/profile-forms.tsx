"use client";

import { useActionState, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Camera, CircleCheck } from "lucide-react";
import { FormField } from "@/components/form-field";
import { ActionFeedback } from "@/components/action-feedback";
import { Input } from "@/components/input";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/button";
import { ModalDialog } from "@/components/modal-dialog";
import { DialogHeader } from "@/components/dialog-layout";
import type { PersonalProfile, PlayerProfile } from "@/lib/profile/profile";
import type { ProfileActionState } from "@/lib/profile/validation";
import { sportyaLevels } from "@/lib/profile/validation";
import { effectiveDisplayName, tennisChoiceLabels, tennisChoiceNames, tennisChoices } from "@/lib/profile/presentation";
import { avatarFileError } from "@/lib/profile/avatar-file-validation";
import { CountrySelect } from "./country-select";
import { usePersistedBaseline } from "./use-persisted-baseline";
import { useProfileFormDirty } from "./unsaved-changes";
import { savePersonalAction, saveTennisAction, uploadAvatarAction, removeAvatarAction } from "./actions";

const initialState: ProfileActionState = {};
const personalFields = [
  ["first_name", "First name", "text", "given-name"], ["last_name", "Last name", "text", "family-name"],
  ["phone", "Phone", "tel", "tel"], ["date_of_birth", "Date of birth", "date", "bday"],
  ["address_line1", "Address line 1", "text", "address-line1"], ["address_line2", "Address line 2", "text", "address-line2"],
  ["city", "City", "text", "address-level2"], ["postal_code", "Postal code", "text", "postal-code"],
  ["country_code", "Country", "text", "country"],
] as const;

const legendClass = "mb-4 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const selectClass = "min-h-11 w-full min-w-0 rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20";

// States whether the form has unsaved edits and keeps Save in reach while it does.
// The negative margins match ProfileSection's content padding.
function SaveBar({ dirty, children }: { dirty: boolean; children: ReactNode }) {
  return <div className={`${dirty ? "sticky bottom-0 z-10" : ""} -mx-5 -mb-5 flex flex-col gap-3 rounded-b-card border-t border-border bg-surface-elevated px-5 py-4 sm:flex-row sm:items-center sm:justify-between md:-mx-6 md:-mb-6 md:px-6 lg:-mx-8 lg:-mb-8 lg:px-8`}>
    <p aria-live="polite" className={`flex items-center gap-2 text-sm ${dirty ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
      {dirty ? <><span aria-hidden="true" className="size-2 rounded-full bg-accent" />Unsaved changes</>
        : <><CircleCheck aria-hidden="true" className="size-4 text-success" />No unsaved changes</>}
    </p>
    <div className="w-full sm:w-fit [&>button]:min-h-11">{children}</div>
  </div>;
}

const personalFieldNames = personalFields.map(([name]) => name);
const tennisFieldNames = ["display_name", "sportya_level", "handedness", "backhand", "preferred_game", "preferred_surface", "bio"] as const;


export function PersonalInformationForm({ profile }: { profile: PersonalProfile }) {
  const [values, setValues] = useState(profile);
  const { state, action, dirty } = usePersistedBaseline(savePersonalAction, values, personalFieldNames);
  useProfileFormDirty("personal", dirty);
  const [edited, setEdited] = useState<{ state: ProfileActionState; fields: string[] } | null>(null);
  const errorFor = (field: string) => edited?.state === state && edited.fields.includes(field) ? undefined : state.fieldErrors?.[field];
  return (
    <form action={action} noValidate className="space-y-8">
      <ActionFeedback state={state} loading="Saving…" />
      {[
        { title: "Contact details", fields: personalFields.slice(0, 4) },
        { title: "Address", fields: personalFields.slice(4) },
      ].map(({ title, fields }) => (
        <fieldset key={title} className="min-w-0">
          <legend className={legendClass}>{title}</legend>
          <div className="grid min-w-0 gap-5 sm:grid-cols-2">
            {fields.map(([name, label, type, autoComplete]) => (
              <FormField key={name} label={label} htmlFor={name} error={errorFor(name)} errorId={`${name}-error`}>
                {name === "country_code" ? <CountrySelect value={values.country_code ?? ""} error={errorFor(name)}
                  onChange={(value) => {
                    setValues({ ...values, country_code: value });
                    setEdited({ state, fields: [...(edited?.state === state ? edited.fields : []), name] });
                  }} /> : <Input id={name} name={name} type={type} autoComplete={autoComplete} value={values[name] ?? ""}
                  className="min-h-11 min-w-0"
                  onChange={(event) => {
                    setValues({ ...values, [name]: event.target.value });
                    setEdited({ state, fields: [...(edited?.state === state ? edited.fields : []), name] });
                  }}
                  aria-invalid={Boolean(errorFor(name))} aria-describedby={errorFor(name) ? `${name}-error` : undefined} />}
              </FormField>
            ))}
          </div>
        </fieldset>
      ))}
      <SaveBar dirty={dirty}><SubmitButton disabled={!dirty} pendingLabel="Saving…">Save personal information</SubmitButton></SaveBar>
    </form>
  );
}


export function TennisProfileForm({ profile, personal = {} }: {
  profile: Pick<PlayerProfile, typeof tennisFieldNames[number] | "rating"> | null; personal?: Partial<Pick<PersonalProfile, "first_name" | "last_name">>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // React's commit-time Action reset bypasses synthetic onReset handlers.
    // Cancel the native reset so controlled field state remains authoritative.
    const preventReset = (event: Event) => event.preventDefault();
    form.addEventListener("reset", preventReset);
    return () => form.removeEventListener("reset", preventReset);
  }, []);
  const [values, setValues] = useState<Record<string, string>>({
    display_name: effectiveDisplayName(profile?.display_name, personal), sportya_level: profile?.sportya_level ?? "",
    handedness: profile?.handedness ?? "", backhand: profile?.backhand ?? "", preferred_game: profile?.preferred_game ?? "",
    preferred_surface: profile?.preferred_surface ?? "", bio: profile?.bio ?? "",
  });
  const { state, action, dirty } = usePersistedBaseline(saveTennisAction, values, tennisFieldNames);
  useProfileFormDirty("tennis", dirty);
  const [edited, setEdited] = useState<{ state: ProfileActionState; fields: string[] } | null>(null);
  const errorFor = (field: string) => edited?.state === state && edited.fields.includes(field) ? undefined : state.fieldErrors?.[field];
  function change(name: string, value: string) {
    setValues({ ...values, [name]: value });
    setEdited({ state, fields: [...(edited?.state === state ? edited.fields : []), name] });
  }
  const fieldProps = (name: string) => ({ id: name, name, value: values[name], "aria-invalid": Boolean(errorFor(name)), "aria-describedby": errorFor(name) ? `${name}-error` : undefined });
  return (
    <form ref={formRef} action={action} noValidate className="space-y-8">
      <ActionFeedback state={state} loading="Saving…" />
      <fieldset className="min-w-0">
        <legend className={legendClass}>Player details</legend>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          {[["display_name", "Display name"], ["sportya_level", "Sportya level"]].map(([name, label]) => (
            <FormField key={name} label={label} htmlFor={name} error={errorFor(name)} errorId={`${name}-error`}>
              {name === "sportya_level" ? <select {...fieldProps(name)} onChange={(event) => change(name, event.target.value)}
                aria-describedby={[`${name}-help`, errorFor(name) ? `${name}-error` : ""].filter(Boolean).join(" ")}
                className={selectClass}>
                <option value="">Not specified</option>
                {sportyaLevels.map((level) => <option key={level} value={level}>Level {level}</option>)}
              </select> : <Input {...fieldProps(name)} className="min-h-11 min-w-0" onChange={(event) => change(name, event.target.value)}
                aria-describedby={[`${name}-help`, errorFor(name) ? `${name}-error` : ""].filter(Boolean).join(" ")} />}
              <p id={`${name}-help`} className="mt-2 text-xs leading-5 text-muted-foreground">{name === "display_name" ? "The name other club players will see." : "Your level on Sportya, if you use it."}</p>
            </FormField>
          ))}
        </div>
      </fieldset>
      <fieldset className="min-w-0">
        <legend className={legendClass}>Playing preferences</legend>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          {tennisChoiceNames.map((name) => (
            <FormField key={name} label={tennisChoiceLabels[name]} htmlFor={name} error={errorFor(name)} errorId={`${name}-error`}>
              <select {...fieldProps(name)} onChange={(event) => change(name, event.target.value)}
                className={selectClass}>
                <option value="">Not specified</option>
                {tennisChoices[name].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </FormField>
          ))}
        </div>
      </fieldset>
      {profile?.rating !== null && profile?.rating !== undefined && <p className="flex flex-wrap items-baseline gap-x-2 rounded-control border border-border bg-background px-3 py-2.5 text-sm text-muted-foreground">Rating <span className="font-heading text-base font-semibold text-primary">{profile.rating}</span> · Managed by the club</p>}
      <FormField label="Bio" htmlFor="bio" error={errorFor("bio")} errorId="bio-error">
        <textarea {...fieldProps("bio")} rows={3} onChange={(event) => change("bio", event.target.value)}
          className="w-full min-w-0 rounded-control border border-border bg-surface px-3 py-2.5 text-sm leading-6 text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20" />
      </FormField>
      <SaveBar dirty={dirty}><SubmitButton disabled={!dirty} pendingLabel="Saving…">Save tennis profile</SubmitButton></SaveBar>
    </form>
  );
}

export function AvatarForms({ hasAvatar, hasProfile }: { hasAvatar: boolean; hasProfile: boolean }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const mutating = useRef(false);
  const exclusiveAction = (action: (state: ProfileActionState, data: FormData) => Promise<ProfileActionState>) =>
    async (state: ProfileActionState, data: FormData) => {
      try {
        return await action(state, data);
      } finally {
        mutating.current = false;
      }
    };
  const [uploadState, uploadAction, uploadPending] = useActionState(exclusiveAction(uploadAvatarAction), initialState);
  const [removeState, removeAction, removePending] = useActionState(exclusiveAction(removeAvatarAction), initialState);
  const pending = uploadPending || removePending;
  const [selection, setSelection] = useState<{ state: ProfileActionState; error?: string } | null>(null);
  const avatarError = selection?.error ?? (selection?.state === uploadState ? undefined : uploadState.fieldErrors?.avatar);
  if (!hasProfile) return <p className="text-sm leading-6 text-muted-foreground">Save your tennis profile to add an avatar.</p>;
  return (
    <>
      <Button ref={triggerRef} type="button" variant="subtle" className="min-h-11 gap-2" aria-haspopup="dialog" onClick={() => setOpen(true)}><Camera aria-hidden="true" className="size-4" />Edit photo</Button>
      <ModalDialog ref={dialogRef} active={open} aria-labelledby={titleId} aria-describedby="avatar-help"
        onCancel={(event) => { if (pending || mutating.current) event.preventDefault(); }}
        onClose={() => { setOpen(false); triggerRef.current?.focus(); }}
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-border bg-surface-elevated p-5 text-foreground shadow-floating backdrop:bg-foreground/50 sm:p-6">
        <DialogHeader titleId={titleId} title="Edit photo" disabled={pending} onClose={() => { if (!mutating.current) dialogRef.current?.close(); }} />
        <div className="mt-4 min-w-0 space-y-4 [&_button]:min-h-11 [&_input]:text-base sm:[&_input]:text-sm">
          <form action={uploadAction} className="space-y-3" onSubmit={(event) => {
            if (mutating.current) { event.preventDefault(); return; }
            const input = event.currentTarget.elements.namedItem("avatar");
            const error = avatarFileError(input instanceof HTMLInputElement ? input.files?.[0] : undefined);
            setSelection({ state: uploadState, error });
            if (error) { event.preventDefault(); return; }
            mutating.current = true;
          }}>
            <ActionFeedback state={uploadState} loading="Saving…" />
            <FormField label={hasAvatar ? "Change avatar" : "Upload avatar"} htmlFor="avatar" error={avatarError} errorId="avatar-error">
              <Input disabled={pending} className="min-h-11 min-w-0 bg-surface py-2 file:mr-3 file:cursor-pointer file:rounded-control file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-primary disabled:opacity-60" id="avatar" name="avatar" type="file" accept="image/jpeg,image/png,image/webp"
                onChange={(event) => setSelection({ state: uploadState, error: avatarFileError(event.target.files?.[0]) })}
                aria-invalid={Boolean(avatarError)} aria-describedby={`avatar-help${avatarError ? " avatar-error" : ""}`} />
            </FormField>
            <p id="avatar-help" className="text-xs text-muted-foreground">JPEG, PNG, or WebP. Maximum 5 MiB.</p>
            <SubmitButton disabled={pending || selection?.state !== uploadState || Boolean(selection.error)} pendingLabel="Uploading…">Save avatar</SubmitButton>
          </form>
          {hasAvatar && <form action={removeAction} className="border-t border-border pt-4" onSubmit={(event) => {
            if (mutating.current) { event.preventDefault(); return; }
            mutating.current = true;
          }}>
            <ActionFeedback state={removeState} loading="Saving…" />
            <SubmitButton disabled={pending} variant="secondary" pendingLabel="Removing…">Remove avatar</SubmitButton>
          </form>}
        </div>
      </ModalDialog>
    </>
  );
}
