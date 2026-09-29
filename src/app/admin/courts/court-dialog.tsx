"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/input";
import type { AdminCourt } from "@/lib/admin/courts";
import type { AdminLocation } from "@/lib/admin/locations";
import { courtSurfaces, courtEnvironments, courtSurfaceLabels, courtEnvironmentLabels } from "@/lib/admin/courts-validation";
import { saveCourtAction } from "./actions";

type LocationChoice = Pick<AdminLocation, "id" | "name" | "is_active">;
const selectClass = "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/20";
const buttonClass = "inline-flex min-h-9 items-center justify-center rounded-control border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60";

export function CourtDialog({ court, locations, locationId }: {
  court?: AdminCourt; locations: LocationChoice[]; locationId?: string;
}) {
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
    setPending(true); setFieldErrors({}); setFormError("");
    const data = new FormData(form);
    const text = (field: string) => { const value = data.get(field); return typeof value === "string" ? value : ""; };
    try {
      const result = await saveCourtAction({
        ...(court ? { id: court.id } : {}),
        fields: {
          location_id: text("location_id"), name: text("name"), surface: text("surface"), environment: text("environment"),
          has_lighting: text("has_lighting") === "true", is_active: text("is_active") === "true",
          display_order: text("display_order").trim() ? Number(text("display_order")) : NaN,
        },
      });
      if (result.ok) {
        toast.success(court ? "Court updated." : "Court created.");
        dialogRef.current?.close();
      } else if (result.reason === "invalid-input") {
        setFieldErrors(result.fieldErrors);
        setFormError("Check the court details below.");
      } else {
        setFormError(result.reason === "duplicate-slug"
          ? court ? "This court’s slug already exists at the selected location. Choose a different location."
            : "A court with this generated slug already exists at the selected location. Use a different name."
          : result.reason === "has-coverage" ? "Remove this court’s coverage periods before changing it to indoor."
          : result.reason === "invalid-location" ? "This location no longer exists. Select another location."
            : "This court no longer exists.");
      }
    } catch {
      setFormError("Unable to save court. Please try again.");
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }

  return <>
    <button type="button" className={buttonClass} disabled={locations.length === 0} onClick={() => {
      setFieldErrors({}); setFormError(""); setOpen(true);
    }}>{court ? "Edit court" : "Create court"}</button>
    <dialog ref={dialogRef} aria-labelledby={`${prefix}-title`}
      onClose={() => setOpen(false)} onCancel={(event) => { if (pendingRef.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50">
      {open && <div className="p-5 sm:p-6">
        <header className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-5">
          <h2 id={`${prefix}-title`} className="font-heading text-xl font-semibold">{court ? "Edit court" : "Create court"}</h2>
          <button type="button" className={buttonClass} disabled={pending} onClick={() => dialogRef.current?.close()}>Close</button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
          {formError && <p role="alert" className="mb-4 text-sm text-danger">{formError}</p>}
          <fieldset disabled={pending} className="space-y-4">
            <div>
              <label htmlFor={`${prefix}-location_id`} className="mb-1.5 block text-sm font-medium">Location</label>
              <select id={`${prefix}-location_id`} name="location_id" required className={selectClass}
                defaultValue={court?.location_id ?? locationId ?? locations[0]?.id ?? ""} {...errorProps("location_id")}>
                {locations.map((location) => <option key={location.id} value={location.id}>{location.name}{location.is_active ? "" : " (Inactive)"}</option>)}
              </select>{fieldError("location_id")}
            </div>
            <div>
              <label htmlFor={`${prefix}-name`} className="mb-1.5 block text-sm font-medium">Name</label>
              <Input id={`${prefix}-name`} name="name" required maxLength={100} defaultValue={court?.name ?? ""} {...errorProps("name")} />
              {fieldError("name")}
            </div>
            <div>
              <label htmlFor={`${prefix}-surface`} className="mb-1.5 block text-sm font-medium">Surface</label>
              <select id={`${prefix}-surface`} name="surface" className={selectClass} defaultValue={court?.surface ?? "clay"} {...errorProps("surface")}>
                {courtSurfaces.map((surface) => <option key={surface} value={surface}>{courtSurfaceLabels[surface]}</option>)}
              </select>{fieldError("surface")}
            </div>
            <div>
              <label htmlFor={`${prefix}-environment`} className="mb-1.5 block text-sm font-medium">Environment</label>
              <select id={`${prefix}-environment`} name="environment" className={selectClass} defaultValue={court?.environment ?? "outdoor"} {...errorProps("environment")}>
                {courtEnvironments.map((environment) => <option key={environment} value={environment}>{courtEnvironmentLabels[environment]}</option>)}
              </select>{fieldError("environment")}
            </div>
            <div>
              <label htmlFor={`${prefix}-has_lighting`} className="mb-1.5 block text-sm font-medium">Lighting</label>
              <select id={`${prefix}-has_lighting`} name="has_lighting" className={selectClass} defaultValue={String(court?.has_lighting ?? false)} {...errorProps("has_lighting")}>
                <option value="false">No lighting</option><option value="true">Floodlit</option>
              </select>{fieldError("has_lighting")}
            </div>
            <div>
              <label htmlFor={`${prefix}-is_active`} className="mb-1.5 block text-sm font-medium">Status</label>
              <select id={`${prefix}-is_active`} name="is_active" className={selectClass} defaultValue={String(court?.is_active ?? true)} {...errorProps("is_active")}>
                <option value="true">Active</option><option value="false">Inactive</option>
              </select>{fieldError("is_active")}
            </div>
            <div>
              <label htmlFor={`${prefix}-display_order`} className="mb-1.5 block text-sm font-medium">Display order</label>
              <Input id={`${prefix}-display_order`} name="display_order" type="number" required step="1" min="-2147483648" max="2147483647"
                defaultValue={court?.display_order ?? 0} {...errorProps("display_order")} />
              <p className="mt-1 text-xs text-muted-foreground">Lower numbers appear first within the location.</p>{fieldError("display_order")}
            </div>
            <button type="submit" aria-busy={pending} className="w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
              {pending ? "Saving…" : "Save court"}
            </button>
          </fieldset>
        </form>
      </div>}
    </dialog>
  </>;
}
