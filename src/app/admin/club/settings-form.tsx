"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { FormField } from "@/components/form-field";
import { clubSettingsSchema, type ClubSettings } from "@/lib/club/schema";
import { saveClubSettingsAction, sendClubTestEmailAction } from "./actions";

export function ClubSettingsForm({ settings }: { settings: ClubSettings }) {
  const id = useId();
  const [values, setValues] = useState(settings);
  const [saved, setSaved] = useState(settings);
  const [operation, setOperation] = useState<"save" | "test" | null>(null);
  const pending = operation !== null;
  const busy = useRef(false);
  const changed = values.officialEmail !== saved.officialEmail || values.senderName !== saved.senderName
    || values.emailsEnabled !== saved.emailsEnabled;

  async function perform(test: boolean) {
    if (busy.current || (!test && !changed)) return;
    busy.current = true; setOperation(test ? "test" : "save");
    try {
      if (test) {
        const result = await sendClubTestEmailAction();
        if (result.ok) toast.success(result.message); else toast.error(result.message);
      } else {
        const result = await saveClubSettingsAction(values);
        if (!result.ok) { toast.error(result.message); return; }
        setSaved(result.settings); setValues(result.settings);
        toast.success("Club settings saved.");
      }
    } catch {
      toast.error(test ? "Unable to send the test email. Try again." : "Unable to save Club settings. Try again.");
    } finally { busy.current = false; setOperation(null); }
  }

  return <section className="max-w-3xl rounded-card border border-border bg-surface p-4 sm:p-5">
    <form className="space-y-5" onSubmit={event => { event.preventDefault(); void perform(false); }}>
      <FormField label="Official email address" htmlFor={`${id}-email`} errorId={`${id}-email-error`}>
        <Input id={`${id}-email`} type="email" required maxLength={254} disabled={pending} value={values.officialEmail}
          onChange={event => setValues({ ...values, officialEmail: event.target.value })} />
      </FormField>
      <FormField label="Email sender name" htmlFor={`${id}-name`} errorId={`${id}-name-error`}>
        <Input id={`${id}-name`} required maxLength={100} disabled={pending} value={values.senderName}
          onChange={event => setValues({ ...values, senderName: event.target.value })} />
      </FormField>
      <p className="text-sm text-muted-foreground">The sender address must be authorized with the configured Brevo provider. Saving an address does not verify provider authorization. Send a test email to check the configuration.</p>
      <label className="flex items-center gap-3 text-sm font-medium">
        <input type="checkbox" role="switch" checked={values.emailsEnabled} disabled={pending}
          onChange={event => setValues({ ...values, emailsEnabled: event.target.checked })} />
        Send transactional emails <span className="text-muted-foreground">{values.emailsEnabled ? "On" : "Off"}</span>
      </label>
      <p className="text-sm text-muted-foreground">Turning this off suppresses queued emails permanently. In-app notifications and Supabase Auth emails continue normally. Requests already in flight may complete.</p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" fullWidth={false} disabled={pending || !changed} aria-busy={operation === "save"}>
          {operation === "save" ? "Saving…" : "Save changes"}</Button>
        <Button type="button" fullWidth={false} disabled={pending || changed || !saved.emailsEnabled || !clubSettingsSchema.safeParse(saved).success}
          aria-busy={operation === "test"} onClick={() => void perform(true)}>{operation === "test" ? "Sending test email…" : "Send test email"}</Button>
      </div>
      <p className="text-sm text-muted-foreground">The test uses saved settings and goes to your verified Admin email address. Brevo acceptance does not confirm inbox delivery.</p>
    </form>
  </section>;
}
