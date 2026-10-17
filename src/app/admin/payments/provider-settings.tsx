"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { StatusBadge } from "@/components/status-badge";
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
  const valid = selected === "" || settings.providers.some((provider) => provider.id === selected && provider.configured);
  const changed = selected !== (active ?? "");
  const available = settings.providers.some((provider) => provider.id === active && provider.configured);

  async function save() {
    if (pendingRef.current || !valid || !changed) return;
    const next = selected;
    setPending(true); pendingRef.current = true;
    const operation = (async () => {
      const result = await selectPaymentProviderAction({ provider: next || null }).catch(() => {
        throw new Error("Unable to change the payment provider. Try again.");
      });
      if (!result.ok) throw new Error(result.message);
      setActive(result.activeProvider); setSelected(result.activeProvider ?? ""); router.refresh();
    })();
    toast.promise(operation, {
      id: `payment-provider-${prefix}`,
      loading: "Saving payment provider settings…",
      success: "Payment provider settings saved.",
      error: (error: unknown) => error instanceof Error ? error.message : "Unable to change the payment provider. Try again.",
    });
    try { await operation; }
    catch { /* Sonner displays the failure; keep the selected provider for retry. */ }
    finally { setPending(false); pendingRef.current = false; }
  }

  // One panel: the saved choice and its control first, then each provider's configuration.
  return <section className="max-w-3xl rounded-card border border-border bg-surface" aria-label="Payment providers">
    <form className="border-b border-border p-4 sm:p-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-primary">Active provider</h3>
        <p className="text-sm text-muted-foreground">{`Saved provider: ${active ? labels[active] : "Not selected"}`}</p>
      </div>
      <label htmlFor={`${prefix}-provider`} className="mt-3 mb-1.5 block text-sm font-medium">Provider for new online payments</label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <select id={`${prefix}-provider`} value={selected} disabled={pending} aria-busy={pending}
          aria-describedby={`${prefix}-availability`}
          onChange={(event) => { setSelected(event.target.value === "stripe" || event.target.value === "netopia" ? event.target.value : ""); }}
          className="min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:max-w-sm">
          <option value="">Not selected — online payment unavailable</option>
          {settings.providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.configured}>
            {labels[provider.id]}{provider.configured ? "" : " — not configured"}
          </option>)}
        </select>
        <Button type="submit" fullWidth={false} className="min-h-11" disabled={pending || !valid || !changed} aria-busy={pending}>{pending ? "Saving…" : "Save changes"}</Button>
      </div>
      <p id={`${prefix}-availability`} className="mt-3 text-sm text-muted-foreground">
        {available && active ? `${labels[active]} is active for new online payments.` : "Online payment is unavailable."}
        {" "}Existing payments keep their original provider. Pay at club is controlled separately in each location’s Booking policy.
      </p>
    </form>
    <div className="p-4 sm:p-5">
      <table className="w-full max-w-md text-left text-sm" aria-label="Provider configuration">
        <thead><tr className="border-b border-border text-xs text-muted-foreground">
          <th scope="col" className="pb-2 font-semibold">Provider</th><th scope="col" className="pb-2 font-semibold">Configuration</th>
        </tr></thead>
        <tbody className="divide-y divide-border">{settings.providers.map((provider) => <tr key={provider.id}>
          <th scope="row" className="py-2.5 font-semibold">{labels[provider.id]}</th>
          <td className="py-2.5"><StatusBadge tone={provider.configured ? "success" : "neutral"}>{provider.configured ? "Configured" : "Not configured"}</StatusBadge></td>
        </tr>)}</tbody>
      </table>
      <p className="mt-3 text-xs text-muted-foreground">Stripe checkout is available when configured and selected. NETOPIA checkout integration is not available yet.</p>
    </div>
  </section>;
}
