"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/input";
import type { AdminLocation } from "@/lib/admin/locations";
import { locationCurrencies, locationCurrencyLabels } from "@/lib/admin/locations-validation";
import { countries } from "@/lib/profile/countries";
import { saveLocationAction } from "./actions";

const textFields = [
  ["name", "Name", 100], ["address_line1", "Address line 1", 200],
  ["address_line2", "Address line 2", 200], ["city", "City", 100],
  ["postal_code", "Postal code", 20], ["timezone", "Timezone", undefined],
] as const;
const selectClass = "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/20";
const buttonClass = "inline-flex min-h-9 items-center justify-center rounded-control border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60";

export function LocationDialog({ location }: { location?: AdminLocation }) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    return () => { dialog?.close(); setOpen(false); };
  }, []);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, [open]);

  function errorProps(field: string) {
    return { "aria-invalid": Boolean(fieldErrors[field]), "aria-describedby": fieldErrors[field] ? `${prefix}-${field}-error` : undefined };
  }
  function fieldError(field: string) {
    return fieldErrors[field] && <p id={`${prefix}-${field}-error`} className="mt-1 text-sm text-danger">{fieldErrors[field]}</p>;
  }

  async function submit(form: HTMLFormElement) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFieldErrors({});
    setFormError("");
    const data = new FormData(form);
    const text = (field: string) => { const value = data.get(field); return typeof value === "string" ? value : ""; };
    try {
      const result = await saveLocationAction({
        ...(location ? { id: location.id } : {}),
        fields: {
          name: text("name"), address_line1: text("address_line1"), address_line2: text("address_line2"),
          city: text("city"), postal_code: text("postal_code"), country_code: text("country_code"),
          timezone: text("timezone"), currency: text("currency"), is_active: text("is_active") === "true",
          display_order: text("display_order").trim() ? Number(text("display_order")) : NaN,
        },
      });
      if (result.ok) {
        toast.success(location ? "Location updated." : "Location created.");
        dialogRef.current?.close();
      } else if (result.reason === "invalid-input") {
        setFieldErrors(result.fieldErrors);
        setFormError("Check the location details below.");
      } else {
        setFormError(result.reason === "duplicate-slug"
          ? "A location with this generated slug already exists. Use a different name."
          : "This location no longer exists.");
      }
    } catch {
      setFormError("Unable to save location. Please try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return <>
    <button type="button" className={buttonClass} onClick={() => {
      setFieldErrors({}); setFormError(""); setOpen(true);
    }}>{location ? "Edit location" : "Create location"}</button>
    <dialog ref={dialogRef} aria-labelledby={`${prefix}-title`}
      onClose={() => setOpen(false)} onCancel={(event) => { if (pendingRef.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50">
      {open && <div className="p-5 sm:p-6">
        <header className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-5">
          <h2 id={`${prefix}-title`} className="font-heading text-xl font-semibold">{location ? "Edit location" : "Create location"}</h2>
          <button type="button" className={buttonClass} disabled={pending} onClick={() => dialogRef.current?.close()}>Close</button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
          {formError && <p role="alert" className="mb-4 text-sm text-danger">{formError}</p>}
          <fieldset disabled={pending} className="space-y-4">
            {textFields.map(([field, label, maxLength]) => <div key={field}>
              <label htmlFor={`${prefix}-${field}`} className="mb-1.5 block text-sm font-medium">{label}</label>
              <Input id={`${prefix}-${field}`} name={field} maxLength={maxLength}
                required={field === "name" || field === "timezone"} {...errorProps(field)}
                placeholder={field === "timezone" ? "Europe/Bucharest" : undefined}
                defaultValue={location?.[field] ?? ""} />
              {field === "timezone" && <p className="mt-1 text-xs text-muted-foreground">Use an IANA timezone identifier, for example Europe/Bucharest.</p>}
              {fieldError(field)}
            </div>)}
            <div>
              <label htmlFor={`${prefix}-country_code`} className="mb-1.5 block text-sm font-medium">Country</label>
              <select id={`${prefix}-country_code`} name="country_code" className={selectClass} defaultValue={location?.country_code ?? ""} {...errorProps("country_code")}>
                <option value="">Not specified</option>
                {countries.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
              </select>{fieldError("country_code")}
            </div>
            <div>
              <label htmlFor={`${prefix}-currency`} className="mb-1.5 block text-sm font-medium">Currency</label>
              <select id={`${prefix}-currency`} name="currency" className={selectClass} defaultValue={location?.currency ?? "EUR"} {...errorProps("currency")}>
                {locationCurrencies.map((currency) => <option key={currency} value={currency}>{currency} — {locationCurrencyLabels[currency]}</option>)}
              </select>{fieldError("currency")}
            </div>
            <div>
              <label htmlFor={`${prefix}-is_active`} className="mb-1.5 block text-sm font-medium">Status</label>
              <select id={`${prefix}-is_active`} name="is_active" className={selectClass} defaultValue={String(location?.is_active ?? true)} {...errorProps("is_active")}>
                <option value="true">Active</option><option value="false">Inactive</option>
              </select>{fieldError("is_active")}
            </div>
            <div>
              <label htmlFor={`${prefix}-display_order`} className="mb-1.5 block text-sm font-medium">Display order</label>
              <Input id={`${prefix}-display_order`} name="display_order" type="number" required step="1" min="-2147483648" max="2147483647"
                defaultValue={location?.display_order ?? 0} {...errorProps("display_order")} />
              <p className="mt-1 text-xs text-muted-foreground">Lower numbers appear first.</p>{fieldError("display_order")}
            </div>
            <button type="submit" aria-busy={pending} className="w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
              {pending ? "Saving…" : "Save location"}
            </button>
          </fieldset>
        </form>
      </div>}
    </dialog>
  </>;
}
