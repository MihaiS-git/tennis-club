"use client";

import { useActionState, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form-field";
import { FormMessage } from "@/components/auth-form";
import { Input } from "@/components/input";
import { SubmitButton } from "@/components/submit-button";
import type { PersonalProfile, PlayerProfile } from "@/lib/profile/profile";
import type { ProfileActionState } from "@/lib/profile/validation";
import { sportyaLevels } from "@/lib/profile/validation";
import { effectiveDisplayName } from "@/lib/profile/presentation";
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

const personalFieldNames = personalFields.map(([name]) => name);
const tennisFieldNames = ["display_name", "sportya_level", "handedness", "backhand", "preferred_game", "preferred_surface", "bio"] as const;

function useFeedback(state: ProfileActionState) {
  useEffect(() => { if (state.success) toast.success(state.success); }, [state]);
}

export function PersonalInformationForm({ profile }: { profile: PersonalProfile }) {
  const [values, setValues] = useState(profile);
  const { state, action, dirty } = usePersistedBaseline(savePersonalAction, values, personalFieldNames);
  useProfileFormDirty("personal", dirty);
  const [edited, setEdited] = useState<{ state: ProfileActionState; fields: string[] } | null>(null);
  useFeedback(state);
  const errorFor = (field: string) => edited?.state === state && edited.fields.includes(field) ? undefined : state.fieldErrors?.[field];
  return (
    <form action={action} noValidate className="space-y-6">
      <FormMessage>{edited?.state === state ? undefined : state.formError}</FormMessage>
      {[
        { title: "Contact details", fields: personalFields.slice(0, 4) },
        { title: "Address", fields: personalFields.slice(4) },
      ].map(({ title, fields }) => (
        <fieldset key={title} className="min-w-0">
          <legend className="mb-4 text-sm font-semibold text-primary">{title}</legend>
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
      <div className="border-t border-border pt-5"><div className="w-full sm:w-fit [&>button]:min-h-11"><SubmitButton disabled={!dirty} pendingLabel="Saving…">Save personal information</SubmitButton></div></div>
    </form>
  );
}

const tennisChoices = {
  handedness: [["right", "Right-handed"], ["left", "Left-handed"]],
  backhand: [["one_handed", "One-handed"], ["two_handed", "Two-handed"]],
  preferred_game: [["singles", "Singles"], ["doubles", "Doubles"], ["both", "Both"]],
  preferred_surface: [["clay", "Clay"], ["hard", "Hard"], ["grass", "Grass"], ["carpet", "Carpet"], ["any", "Any"]],
} as const;
const choiceLabels = { handedness: "Handedness", backhand: "Backhand", preferred_game: "Preferred game", preferred_surface: "Preferred surface" };
const tennisChoiceNames = ["handedness", "backhand", "preferred_game", "preferred_surface"] as const;

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
  useFeedback(state);
  const errorFor = (field: string) => edited?.state === state && edited.fields.includes(field) ? undefined : state.fieldErrors?.[field];
  function change(name: string, value: string) {
    setValues({ ...values, [name]: value });
    setEdited({ state, fields: [...(edited?.state === state ? edited.fields : []), name] });
  }
  const fieldProps = (name: string) => ({ id: name, name, value: values[name], "aria-invalid": Boolean(errorFor(name)), "aria-describedby": errorFor(name) ? `${name}-error` : undefined });
  return (
    <form ref={formRef} action={action} noValidate className="space-y-6">
      <FormMessage>{edited?.state === state ? undefined : state.formError}</FormMessage>
      <fieldset className="min-w-0">
        <legend className="mb-4 text-sm font-semibold text-primary">Player details</legend>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          {[["display_name", "Display name"], ["sportya_level", "Sportya level"]].map(([name, label]) => (
            <FormField key={name} label={label} htmlFor={name} error={errorFor(name)} errorId={`${name}-error`}>
              {name === "sportya_level" ? <select {...fieldProps(name)} onChange={(event) => change(name, event.target.value)}
                aria-describedby={[`${name}-help`, errorFor(name) ? `${name}-error` : ""].filter(Boolean).join(" ")}
                className="min-h-11 w-full min-w-0 rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:ring-2 focus:ring-focus/20">
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
        <legend className="mb-4 text-sm font-semibold text-primary">Playing preferences</legend>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          {tennisChoiceNames.map((name) => (
            <FormField key={name} label={choiceLabels[name]} htmlFor={name} error={errorFor(name)} errorId={`${name}-error`}>
              <select {...fieldProps(name)} onChange={(event) => change(name, event.target.value)}
                className="min-h-11 w-full min-w-0 rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:ring-2 focus:ring-focus/20">
                <option value="">Not specified</option>
                {tennisChoices[name].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </FormField>
          ))}
        </div>
      </fieldset>
      {profile?.rating !== null && profile?.rating !== undefined && <p className="text-sm text-muted-foreground">Rating <span className="font-semibold text-foreground">{profile.rating}</span> · Managed by the club</p>}
      <FormField label="Bio" htmlFor="bio" error={errorFor("bio")} errorId="bio-error">
        <textarea {...fieldProps("bio")} rows={3} onChange={(event) => change("bio", event.target.value)}
          className="w-full min-w-0 rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:ring-2 focus:ring-focus/20" />
      </FormField>
      <div className="border-t border-border pt-5"><div className="w-full sm:w-fit [&>button]:min-h-11"><SubmitButton disabled={!dirty} pendingLabel="Saving…">Save tennis profile</SubmitButton></div></div>
    </form>
  );
}

export function AvatarForms({ hasAvatar, hasProfile }: { hasAvatar: boolean; hasProfile: boolean }) {
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
  useFeedback(uploadState);
  useFeedback(removeState);
  if (!hasProfile) return <p className="text-sm text-muted-foreground">Save your tennis profile to add an avatar.</p>;
  return (
    <details className="min-w-0">
      <summary className="min-h-11 cursor-pointer rounded-control px-1 py-3 text-sm font-medium text-primary hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Edit photo</summary>
      <div className="space-y-4 pt-3 [&_button]:min-h-11">
        <form action={uploadAction} className="space-y-3" onSubmit={(event) => {
          if (mutating.current) { event.preventDefault(); return; }
          const input = event.currentTarget.elements.namedItem("avatar");
          const error = avatarFileError(input instanceof HTMLInputElement ? input.files?.[0] : undefined);
          setSelection({ state: uploadState, error });
          if (error) { event.preventDefault(); return; }
          mutating.current = true;
        }}>
          <FormMessage>{uploadState.formError}</FormMessage>
          <FormField label={hasAvatar ? "Change avatar" : "Upload avatar"} htmlFor="avatar" error={avatarError} errorId="avatar-error">
            <Input disabled={pending} className="min-h-11 min-w-0" id="avatar" name="avatar" type="file" accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setSelection({ state: uploadState, error: avatarFileError(event.target.files?.[0]) })}
              aria-invalid={Boolean(avatarError)} aria-describedby={`avatar-help${avatarError ? " avatar-error" : ""}`} />
          </FormField>
          <p id="avatar-help" className="text-xs text-muted-foreground">JPEG, PNG, or WebP. Maximum 5 MiB.</p>
          <SubmitButton disabled={pending} variant="secondary" pendingLabel="Uploading…">Save avatar</SubmitButton>
        </form>
        {hasAvatar && <form action={removeAction} onSubmit={(event) => {
          if (mutating.current) { event.preventDefault(); return; }
          mutating.current = true;
        }}>
          <FormMessage>{removeState.formError}</FormMessage>
          <SubmitButton disabled={pending} variant="secondary" pendingLabel="Removing…">Remove avatar</SubmitButton>
        </form>}
      </div>
    </details>
  );
}
