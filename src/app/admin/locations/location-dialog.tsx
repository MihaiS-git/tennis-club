"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/input";
import { ModalDialog } from "@/components/modal-dialog";
import type { AdminLocation } from "@/lib/admin/locations";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import {
  CountryCombobox,
  CurrencySelect,
  StatusSelect,
  TimezoneCombobox,
} from "./location-controls";
import { saveLocationAction } from "./actions";
import { LocationArchiveControl } from "./location-archive-control";
import { OpeningHoursEntry } from "./opening-hours-entry";

const emptyIntervals: OpeningInterval[] = [];

const textFields = [
  ["name", "Name", 100],
  ["address_line1", "Address line 1", 200],
  ["address_line2", "Address line 2", 200],
  ["city", "City", 100],
  ["postal_code", "Postal code", 20],
] as const;
const buttonClass =
  "inline-flex min-h-9 items-center justify-center rounded-control border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60";

export function LocationDialog({
  location,
  intervals = emptyIntervals,
  open: controlledOpen,
  onOpenChange,
}: {
  location?: AdminLocation;
  intervals?: OpeningInterval[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, setPending] = useState(false);
  const archived = location?.archived_at != null;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");

  function errorProps(field: string) {
    return {
      "aria-invalid": Boolean(fieldErrors[field]),
      "aria-describedby": fieldErrors[field]
        ? `${prefix}-${field}-error`
        : undefined,
    };
  }
  function fieldError(field: string) {
    return (
      fieldErrors[field] && (
        <p id={`${prefix}-${field}-error`} className="mt-1 text-sm text-danger">
          {fieldErrors[field]}
        </p>
      )
    );
  }

  async function submit(form: HTMLFormElement) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFieldErrors({});
    setFormError("");
    const data = new FormData(form);
    const text = (field: string) => {
      const value = data.get(field);
      return typeof value === "string" ? value : "";
    };
    try {
      const result = await saveLocationAction({
        ...(location ? { id: location.id } : {}),
        fields: {
          name: text("name"),
          address_line1: text("address_line1"),
          address_line2: text("address_line2"),
          city: text("city"),
          postal_code: text("postal_code"),
          country_code: text("country_code"),
          timezone: text("timezone"),
          currency: text("currency"),
          is_active: text("is_active") === "true",
          display_order: location?.display_order ?? 0,
        },
      });
      if (result.ok) {
        toast.success(location ? "Location updated." : "Location created.");
        dialogRef.current?.close();
      } else if (result.reason === "invalid-input") {
        setFieldErrors(result.fieldErrors);
        setFormError("Check the location details below.");
      } else {
        setFormError(
          result.reason === "duplicate-slug"
            ? "A location with this generated slug already exists. Use a different name."
            : "This location no longer exists.",
        );
      }
    } catch {
      setFormError("Unable to save location. Please try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <>
      {controlledOpen === undefined && (
        <button
          type="button"
          aria-label={location ? `Edit location ${location.name}` : undefined}
          className={
            location
              ? "inline-flex max-w-full cursor-pointer items-center rounded-control px-1.5 py-1 text-left font-semibold text-foreground transition-colors hover:bg-surface-muted hover:text-primary focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              : buttonClass
          }
          onClick={() => {
            setFieldErrors({});
            setFormError("");
            setOpen(true);
          }}
        >
          {location ? location.name : "Create location"}
        </button>
      )}
      <ModalDialog
        ref={dialogRef}
        active={open}
        aria-labelledby={`${prefix}-title`}
        onClose={() => {
          if (!dialogRef.current?.open) setOpen(false);
        }}
        onCancel={(event) => {
          if (pendingRef.current) event.preventDefault();
        }}
        className="fixed inset-0 m-auto w-[calc(100%-1.5rem)] max-w-2xl rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50 sm:w-[calc(100%-2rem)]"
      >
        {open && (
          <div className="p-4 sm:p-6">
            <header className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
              <h2
                id={`${prefix}-title`}
                className="font-heading text-xl font-semibold"
              >
                {location ? "Edit location" : "Create location"}
              </h2>
              <button
                type="button"
                className="rounded-control px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
                disabled={pending}
                onClick={() => dialogRef.current?.close()}
              >
                Close
              </button>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit(event.currentTarget);
              }}
            >
              {formError && (
                <p role="alert" className="mb-4 text-sm text-danger">
                  {formError}
                </p>
              )}
              {archived && (
                <p className="mb-4 text-sm text-muted-foreground">
                  Restore this location to edit its details.
                </p>
              )}
              <fieldset disabled={pending || archived}>
                <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
                  {textFields.map(([field, label, maxLength]) => (
                    <div
                      key={field}
                      className={
                        field === "name" || field.startsWith("address_line")
                          ? "sm:col-span-2"
                          : ""
                      }
                    >
                      <label
                        htmlFor={`${prefix}-${field}`}
                        className="mb-1.5 block text-sm font-medium"
                      >
                        {label}
                      </label>
                      <Input
                        id={`${prefix}-${field}`}
                        name={field}
                        maxLength={maxLength}
                        required={field === "name"}
                        autoFocus={field === "name"}
                        {...errorProps(field)}
                        defaultValue={location?.[field] ?? ""}
                      />
                      {fieldError(field)}
                    </div>
                  ))}
                  <div>
                    <label
                      htmlFor={`${prefix}-country_code`}
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Country
                    </label>
                    <CountryCombobox
                      id={`${prefix}-country_code`}
                      name="country_code"
                      defaultValue={location?.country_code ?? ""}
                      {...errorProps("country_code")}
                    />
                    {fieldError("country_code")}
                  </div>
                  <div>
                    <label
                      htmlFor={`${prefix}-timezone`}
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Timezone
                    </label>
                    <TimezoneCombobox
                      id={`${prefix}-timezone`}
                      name="timezone"
                      defaultValue={location?.timezone ?? ""}
                      {...errorProps("timezone")}
                    />
                    {fieldError("timezone")}
                  </div>
                  <div>
                    <label
                      htmlFor={`${prefix}-currency`}
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Currency
                    </label>
                    <CurrencySelect
                      id={`${prefix}-currency`}
                      name="currency"
                      defaultValue={location?.currency ?? "EUR"}
                      {...errorProps("currency")}
                    />
                    {fieldError("currency")}
                  </div>
                  <div>
                    <label
                      htmlFor={`${prefix}-is_active`}
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Status
                    </label>
                    <StatusSelect
                      id={`${prefix}-is_active`}
                      name="is_active"
                      defaultValue={String(location?.is_active ?? true)}
                      {...errorProps("is_active")}
                    />
                    {fieldError("is_active")}
                  </div>
                </div>
                {!archived && (
                  <div className="mt-5 flex justify-end border-t border-border pt-4">
                    <button
                      type="submit"
                      aria-busy={pending}
                      className="w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60 sm:w-auto"
                    >
                      {pending ? "Saving…" : "Save location"}
                    </button>
                  </div>
                )}
              </fieldset>
            </form>
            {location && (
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-border pt-4">
                <OpeningHoursEntry locationId={location.id} locationName={location.name} intervals={intervals} />
                <LocationArchiveControl
                  id={location.id}
                  name={location.name}
                  archived={location.archived_at !== null}
                  onSuccess={() => dialogRef.current?.close()}
                />
              </div>
            )}
          </div>
        )}
      </ModalDialog>
    </>
  );
}
