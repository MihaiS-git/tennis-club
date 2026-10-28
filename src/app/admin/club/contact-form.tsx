"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { FormField } from "@/components/form-field";
import type { ClubContact } from "@/lib/club/schema";
import { saveClubContactAction } from "./actions";

export function ClubContactForm({ contact }: { contact: ClubContact }) {
  const id = useId();
  const [values, setValues] = useState(contact);
  const [saved, setSaved] = useState(contact);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const changed = values.contactEmail !== saved.contactEmail || values.contactPhone !== saved.contactPhone;

  async function save() {
    if (busy.current || !changed) return;
    busy.current = true; setPending(true);
    try {
      const result = await saveClubContactAction(values);
      if (!result.ok) { toast.error(result.message); return; }
      setSaved(result.contact); setValues(result.contact);
      toast.success("Contact details saved.");
    } catch {
      toast.error("Unable to save contact details. Try again.");
    } finally { busy.current = false; setPending(false); }
  }

  return <section aria-labelledby={`${id}-heading`} className="max-w-3xl rounded-card border border-border bg-surface p-4 sm:p-5">
    <h2 id={`${id}-heading`} className="font-heading text-xl font-semibold text-primary">Public contact</h2>
    <p className="mt-1 text-sm text-muted-foreground">Shown to visitors on the Contact page. Leave a field empty to hide it. These details are separate from the email sender and never change how emails are sent.</p>
    <form className="mt-5 space-y-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FormField label="Contact email address" htmlFor={`${id}-email`} errorId={`${id}-email-error`}>
        <Input id={`${id}-email`} type="email" maxLength={254} autoComplete="off" disabled={pending} value={values.contactEmail}
          onChange={event => setValues({ ...values, contactEmail: event.target.value })} />
      </FormField>
      <FormField label="Telephone number" htmlFor={`${id}-phone`} errorId={`${id}-phone-error`}>
        <Input id={`${id}-phone`} type="tel" maxLength={30} autoComplete="off" disabled={pending} value={values.contactPhone}
          placeholder="+40 21 123 4567" onChange={event => setValues({ ...values, contactPhone: event.target.value })} />
      </FormField>
      <p className="text-sm text-muted-foreground">Include the international dialling code so visitors can call from any country.</p>
      <Button type="submit" fullWidth={false} disabled={pending || !changed} aria-busy={pending}>
        {pending ? "Saving…" : "Save contact details"}</Button>
    </form>
  </section>;
}
