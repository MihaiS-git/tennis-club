"use client";

import { useId, useRef, useState } from "react";
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
  const available = settings.providers.some((provider) => provider.id === active && provider.configured);

  async function select(value: string) {
    if (pendingRef.current) return;
    const provider = settings.providers.find((item) => item.id === value);
    if (value && (!provider || !provider.configured)) return;
    const next = provider?.id ?? "";
    setSelected(next); setError(""); setPending(true); pendingRef.current = true;
    try {
      const result = await selectPaymentProviderAction({ provider: next || null });
      if (result.ok) { setActive(result.activeProvider); router.refresh(); }
      else setError(result.message);
    } catch { setError("Unable to change the payment provider. Try again."); }
    finally { setPending(false); pendingRef.current = false; }
  }

  return <section className="max-w-2xl rounded-control border border-border bg-surface p-4 sm:p-5" aria-label="Payment providers">
    <table className="mb-5 w-full text-left text-sm" aria-label="Provider configuration">
      <thead><tr className="border-b border-border text-muted-foreground">
        <th scope="col" className="pb-2 font-medium">Provider</th><th scope="col" className="pb-2 font-medium">Configuration</th>
      </tr></thead>
      <tbody>{settings.providers.map((provider) => <tr key={provider.id} className="border-b border-border">
        <th scope="row" className="py-3 font-semibold">{labels[provider.id]}</th>
        <td className="py-3">{provider.configured ? "Configured" : "Not configured"}</td>
      </tr>)}</tbody>
    </table>
    <label htmlFor={`${prefix}-provider`} className="mb-1.5 block text-sm font-medium">Active provider for new online payments</label>
    <select id={`${prefix}-provider`} value={selected} disabled={pending} aria-busy={pending}
      aria-describedby={`${prefix}-error ${prefix}-availability`} aria-invalid={Boolean(error)}
      onChange={(event) => void select(event.target.value)}
      className="min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground">
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
    <p className="mt-2 text-sm text-muted-foreground">Stripe checkout is available when configured and selected. NETOPIA checkout integration is not available yet.</p>
  </section>;
}
