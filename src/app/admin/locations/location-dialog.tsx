"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/input";
import { Button, DialogCloseButton } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { useEditableFormBaseline } from "@/components/use-editable-form-baseline";
import { ModalDialog } from "@/components/modal-dialog";
import type { AdminLocation } from "@/lib/admin/locations";
import { defaultCustomerCancellationNoticeMinutes } from "@/lib/bookings/cancellation-policy";
import { locationFieldsSchema } from "@/lib/admin/locations-validation";
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
const editableFields = ["name", "address_line1", "address_line2", "city", "postal_code", "country_code", "timezone", "currency", "is_active", "is_public", "allow_pay_at_club", "customer_cancellation_notice_minutes"];
function validLocationCreate(form: HTMLFormElement) {
  const data = new FormData(form);
  const text = (field: string) => String(data.get(field) ?? "");
  return locationFieldsSchema.safeParse({
    name: text("name"), address_line1: text("address_line1"), address_line2: text("address_line2"),
    city: text("city"), postal_code: text("postal_code"), country_code: text("country_code"),
    timezone: text("timezone"), currency: text("currency"), is_active: text("is_active") === "true",
    is_public: text("is_public") === "true",
    allow_pay_at_club: text("allow_pay_at_club") === "true",
    customer_cancellation_notice_minutes: Number(text("customer_cancellation_notice_minutes")),
    display_order: 0,
  }).success;
}

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
  const saveTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingSaveFormRef = useRef<HTMLFormElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, setPending] = useState(false);
  const archived = location?.archived_at != null;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const { attach, dirty, valid, sync, submitted, commit } = useEditableFormBaseline(
    editableFields, (field, value) => field === "country_code" ? value.trim().toUpperCase() : value.trim(), validLocationCreate,
  );

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
    const saved = submitted(form);
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
          is_public: text("is_public") === "true",
          allow_pay_at_club: text("allow_pay_at_club") === "true",
          customer_cancellation_notice_minutes: Number(text("customer_cancellation_notice_minutes")),
          display_order: location?.display_order ?? 0,
        },
      });
      if (result.ok) {
        commit(saved);
        setDeactivating(false);
        toast.success(location ? "Location updated." : "Location created.");
        dialogRef.current?.close();
      } else if (result.reason === "invalid-input") {
        setFieldErrors(result.fieldErrors);
        setFormError("Check the location details below.");
      } else if (result.reason === "not-ready") {
        setFormError(result.message);
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
      {!location && controlledOpen === undefined && (
        <Button
          type="button"
          variant="secondary" size="small"
          onClick={() => {
            setFieldErrors({});
            setFormError("");
            setOpen(true);
          }}
        >
          Create location
        </Button>
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
              <DialogCloseButton disabled={pending} onClick={() => dialogRef.current?.close()} />
            </header>
            <form
              ref={attach}
              onInput={sync}
              onChange={sync}
              onSubmit={(event) => {
                event.preventDefault();
                if (location?.is_active && new FormData(event.currentTarget).get("is_active") === "false") {
                  pendingSaveFormRef.current = event.currentTarget;
                  setFormError("");
                  setDeactivating(true);
                  return;
                }
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
                      onValueChange={() => requestAnimationFrame(sync)}
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
                      onValueChange={() => requestAnimationFrame(sync)}
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
                  <div>
                    <label htmlFor={`${prefix}-is_public`} className="mb-1.5 block text-sm font-medium">Public booking</label>
                    <select id={`${prefix}-is_public`} name="is_public" defaultValue={String(location?.is_public ?? false)}
                      className="min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground"
                      {...errorProps("is_public")}>
                      <option value="false">Disabled</option>
                      <option value="true">Enabled</option>
                    </select>
                    {fieldError("is_public")}
                  </div>
                </div>
                <section className="mt-4 border-t border-border pt-4" aria-labelledby={`${prefix}-booking-policy`}>
                  <h3 id={`${prefix}-booking-policy`} className="mb-3 text-sm font-semibold">Booking policy</h3>
                  <label htmlFor={`${prefix}-allow_pay_at_club`} className="mb-1.5 block text-sm font-medium">Pay at club</label>
                  <select id={`${prefix}-allow_pay_at_club`} name="allow_pay_at_club" defaultValue={String(location?.allow_pay_at_club ?? false)}
                    className="mb-3 min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground" {...errorProps("allow_pay_at_club")}>
                    <option value="false">Disabled</option><option value="true">Enabled</option>
                  </select>
                  {fieldError("allow_pay_at_club")}
                  <label htmlFor={`${prefix}-customer_cancellation_notice_minutes`} className="mb-1.5 block text-sm font-medium">
                    Customer cancellation notice
                  </label>
                  <select id={`${prefix}-customer_cancellation_notice_minutes`} name="customer_cancellation_notice_minutes"
                    defaultValue={location?.customer_cancellation_notice_minutes ?? defaultCustomerCancellationNoticeMinutes}
                    className="min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground"
                    aria-invalid={Boolean(fieldErrors.customer_cancellation_notice_minutes)}
                    aria-describedby={`${prefix}-policy-help${fieldErrors.customer_cancellation_notice_minutes ? ` ${prefix}-customer_cancellation_notice_minutes-error` : ""}`}>
                    <option value={0}>Until booking start</option>
                    {[60, 120, 240, 720, 1440, 2880].map((minutes) => (
                      <option key={minutes} value={minutes}>{minutes / 60} {minutes === 60 ? "hour" : "hours"}</option>
                    ))}
                    {location && ![0, 60, 120, 240, 720, 1440, 2880].includes(location.customer_cancellation_notice_minutes) && (
                      <option value={location.customer_cancellation_notice_minutes}>{location.customer_cancellation_notice_minutes} minutes</option>
                    )}
                  </select>
                  <p id={`${prefix}-policy-help`} className="mt-1 text-sm text-muted-foreground">
                    Customers may cancel only when at least this amount of time remains before the booking starts.
                  </p>
                  {fieldError("customer_cancellation_notice_minutes")}
                </section>
              </fieldset>
              <div className={`mt-5 items-center gap-3 border-t border-border pt-4 ${archived ? "flex" : "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"}`}>
                <div className="min-w-0">
                  {location && !archived && <OpeningHoursEntry locationId={location.id} locationName={location.name} intervals={intervals} />}
                </div>
                {location && <LocationArchiveControl
                  id={location.id}
                  name={location.name}
                  archived={location.archived_at !== null}
                  onSuccess={() => dialogRef.current?.close()}
                />}
                <div className="justify-self-end">
                  {!archived && <Button
                    ref={saveTriggerRef}
                    type="submit"
                    disabled={pending || (location ? !dirty : !valid)}
                    aria-busy={pending}
                    fullWidth={false}
                  >
                    {pending ? "Saving…" : "Save location"}
                  </Button>}
                </div>
              </div>
            </form>
          </div>
        )}
      </ModalDialog>
      <ConfirmationDialog open={deactivating} title={`Deactivate ${location?.name ?? "location"}?`}
        message={`${location?.name ?? "This location"} will become unavailable for normal use until reactivated.`}
        confirmLabel="Deactivate location" pending={pending} error={formError} returnFocusRef={saveTriggerRef}
        onClose={() => { if (!pendingRef.current) setDeactivating(false); }}
        onConfirm={() => { if (pendingSaveFormRef.current) void submit(pendingSaveFormRef.current); }} />
    </>
  );
}
