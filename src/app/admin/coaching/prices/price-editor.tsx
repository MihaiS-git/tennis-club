"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import type { AdminCoachingPrice } from "@/lib/coaching/admin";
import type { CoachingMutationResult } from "@/lib/coaching/validation";
import { majorAmountSchema, minorToMajor, type LocationCurrency } from "@/lib/pricing/money";
import { coachingFailureMessages } from "../coaching-form";

type PriceTarget = { program_id: string; duration_minutes: number; participant_count: number; currency: LocationCurrency };
type PriceActions = {
  save: (input: PriceTarget & { amount: string }) => Promise<CoachingMutationResult>;
  remove: (input: PriceTarget) => Promise<CoachingMutationResult>;
};

// Inline scalar edit of one lesson price amount for one participant count (a coach's own
// override, through the given actions). An empty amount means "not set".
export function PriceEditor({ label, target, price, emptyHint, actions, confirmRemoval = true }: {
  label: string; target: PriceTarget; price?: Pick<AdminCoachingPrice, "amount_minor">; emptyHint: string;
  actions: PriceActions; confirmRemoval?: boolean;
}) {
  const { currency } = target;
  const router = useRouter();
  const id = useId();
  const removeRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const initial = price ? minorToMajor(price.amount_minor) : "";
  const [value, setValue] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Follow refreshed server values while the field is untouched.
  const [serverInitial, setServerInitial] = useState(initial);
  if (serverInitial !== initial) {
    setServerInitial(initial);
    if (value === baseline) { setValue(initial); setBaseline(initial); }
  }
  const valid = majorAmountSchema.safeParse(value).success;
  const dirty = value.trim() !== baseline;

  async function run(remove: boolean) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(null);
    const notification = toast.loading(remove ? "Removing price…" : "Saving price…");
    try {
      const result = remove ? await actions.remove(target) : await actions.save({ ...target, amount: value });
      if (result.ok) {
        toast.success(remove ? "Price removed." : "Price saved.", { id: notification });
        const next = remove ? "" : value.trim();
        setValue(next); setBaseline(next); setRemoving(false);
        router.refresh();
      } else if (result.reason === "invalid-input") {
        toast.dismiss(notification); setError(result.fieldErrors.amount ?? Object.values(result.fieldErrors)[0] ?? "Enter a valid price.");
      } else {
        toast.dismiss(notification); setError(coachingFailureMessages[result.reason]);
      }
    } catch {
      toast.error("Unable to change the price. Please try again.", { id: notification });
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }

  return <form className="min-w-0" onSubmit={(event) => { event.preventDefault(); if (valid && dirty) void run(false); }}>
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="sr-only">{label}</label>
      <div className="flex min-h-9 w-36 items-center rounded-control border border-border bg-surface pr-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-focus/20">
        <input id={id} value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" placeholder={emptyHint}
          disabled={pending} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none" />
        <span className="text-xs font-semibold text-muted-foreground">{currency}</span>
      </div>
      {dirty && <Button type="submit" size="small" fullWidth={false} disabled={pending || !valid} aria-busy={pending}>Save</Button>}
      {dirty && <Button type="button" variant="subtle" size="small" disabled={pending} onClick={() => { setValue(baseline); setError(null); }}>Cancel</Button>}
      {!dirty && price && <Button ref={removeRef} type="button" variant="subtle" size="small" disabled={pending} onClick={() => confirmRemoval ? setRemoving(true) : void run(true)}>Remove</Button>}
    </div>
    {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger">{error}</p>}
    <ConfirmationDialog open={removing} title="Remove price?" message={`${label} will no longer have a configured price.`}
      confirmLabel="Remove price" pending={pending} returnFocusRef={removeRef}
      onClose={() => { if (!pendingRef.current) setRemoving(false); }} onConfirm={() => void run(true)} />
  </form>;
}
