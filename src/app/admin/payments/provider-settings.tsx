"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { useRouter } from "next/navigation";
import type { PaymentProvider, PaymentSettings } from "@/lib/payments/domain";
import { selectPaymentProviderAction } from "./actions";

const labels: Record<PaymentProvider, string> = { stripe: "Stripe", netopia: "NETOPIA" };

export function PaymentProviderSettings({ settings }: { settings: PaymentSettings }) {
  const prefix = useId();
  const router = useRouter();
  const pendingRef = useRef(false);
  const [selected, setSelected] = useState<PaymentProvider | "">(settings.activeProvider ?? "");
  const [active, setActive] = useState(settings.activeProvider);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const valid = selected === "" || settings.providers.some((provider) => provider.id === selected && provider.configured);
  const changed = selected !== (active ?? "");
  const available = settings.providers.some((provider) => provider.id === active && provider.configured);

  async function save() {
    if (pendingRef.current || !valid || !changed) return;
    const next = selected;
    setError(""); setSuccess(""); setPending(true); pendingRef.current = true;
    try {
      const result = await selectPaymentProviderAction({ provider: next || null });
      if (result.ok) { setActive(result.activeProvider); setSelected(result.activeProvider ?? ""); setSuccess("Payment provider settings saved."); toast.success("Payment provider settings saved."); router.refresh(); }
      else setError(result.message);
    } catch { setError("Unable to change the payment provider. Try again."); }
    finally { setPending(false); pendingRef.current = false; }
  }

  return <section className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 lg:gap-8" aria-label="Payment providers">
    <div className="min-w-0 rounded-control border border-border bg-surface p-4 sm:p-5">
    <h3 className="mb-4 font-semibold">Provider configuration</h3>
    <table className="mb-5 w-full text-left text-sm" aria-label="Provider configuration">
      <thead><tr className="border-b border-border text-muted-foreground">
        <th scope="col" className="pb-2 font-medium">Provider</th><th scope="col" className="pb-2 font-medium">Configuration</th>
      </tr></thead>
      <tbody>{settings.providers.map((provider) => <tr key={provider.id} className="border-b border-border">
        <th scope="row" className="py-3 font-semibold">{labels[provider.id]}</th>
        <td className="py-3">{provider.configured ? "Configured" : "Not configured"}</td>
      </tr>)}</tbody>
    </table>
    <p className="text-sm text-muted-foreground">Stripe checkout is available when configured and selected. NETOPIA checkout integration is not available yet.</p>
    </div>
    <form className="min-w-0 rounded-control border border-border bg-surface p-4 sm:p-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <h3 className="mb-4 font-semibold">Active provider</h3>
    <label htmlFor={`${prefix}-provider`} className="mb-1.5 block text-sm font-medium">Active provider for new online payments</label>
    <select id={`${prefix}-provider`} value={selected} disabled={pending} aria-busy={pending}
      aria-describedby={`${prefix}-error ${prefix}-availability`} aria-invalid={Boolean(error)}
      onChange={(event) => { setSelected(event.target.value === "stripe" || event.target.value === "netopia" ? event.target.value : ""); setError(""); setSuccess(""); }}
      className="min-h-11 w-full max-w-sm rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground">
      <option value="">Not selected — online payment unavailable</option>
      {settings.providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.configured}>
        {labels[provider.id]}{provider.configured ? "" : " — not configured"}
      </option>)}
    </select>
    <p id={`${prefix}-error`} role={error ? "alert" : undefined} className="mt-2 min-h-6 text-sm text-danger">{error}</p>
    <p id={`${prefix}-availability`} className="text-sm text-muted-foreground">
      {available && active ? `${labels[active]} is active for new online payments.` : "Online payment is unavailable."}
      {" "}Existing payments keep their original provider. Pay at club is controlled separately in each location’s Booking policy.
    </p>
    <p className="mt-3 text-sm font-medium">Persisted active provider: {active ? labels[active] : "Not selected"}</p>
    <Button type="submit" fullWidth={false} className="mt-4" disabled={pending || !valid || !changed} aria-busy={pending}>{pending ? "Saving…" : "Save changes"}</Button>
    <p role="status" className="mt-2 text-sm text-muted-foreground">{pending ? "Saving payment provider settings…" : success}</p>
    </form>
  </section>;
}
