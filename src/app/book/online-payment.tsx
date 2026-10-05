"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { Button } from "@/components/button";
import type { OnlineCheckout } from "@/lib/payments/domain";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import type { LocationCurrency } from "@/lib/pricing/money";
import { readCheckoutStatusAction } from "./actions";

type Props = { checkout: OnlineCheckout; holdExpiresAt: string; disabled?: boolean;
  onConfirmed: (amount: number, currency: LocationCurrency, policy: ConfirmedCancellationPolicy | null) => void };

export function OnlinePayment(props: Props) {
  const stripe = useMemo(() => loadStripe(props.checkout.presentation.publishableKey), [props.checkout.presentation.publishableKey]);
  return <Elements stripe={stripe} options={{ clientSecret: props.checkout.presentation.clientSecret,
    appearance: { theme: "stripe", variables: { borderRadius: "8px" } } }}>
    <PaymentForm {...props} />
  </Elements>;
}

function PaymentForm({ checkout, holdExpiresAt, onConfirmed, disabled = false }: Props) {
  const stripe = useStripe(), elements = useElements();
  const [processing, setProcessing] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [ready, setReady] = useState(false);
  const confirmed = useRef(onConfirmed);
  useEffect(() => { confirmed.current = onConfirmed; }, [onConfirmed]);
  useEffect(() => {
    let stopped = false, busy = false;
    async function check() {
      if (busy || stopped) return;
      busy = true;
      try {
        const result = await readCheckoutStatusAction({ attemptId: checkout.attemptId, token: checkout.token });
        if (stopped) return;
        if (!result.ok) { setError(result.message); return; }
        if (result.status === "confirmed") {
          stopped = true;
          confirmed.current(result.totalAmountMinor, result.currency, result.cancellationPolicy);
        } else if (result.status !== "pending_payment") {
          stopped = true; setTerminal(true); setProcessing(false);
          setError("Payment did not confirm this booking. The court hold has been released. Please choose a time again.");
        }
      } catch { if (!stopped) setError("Unable to check payment. We will keep checking."); }
      finally { busy = false; }
    }
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [checkout.attemptId, checkout.token]);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || submitting.current || terminal || disabled) return;
    submitting.current = true; setProcessing(true); setError("");
    try {
      // Card payments only. Authentication completes inline; confirmation comes from our server.
      const result = await stripe.confirmPayment({ elements, redirect: "if_required",
        confirmParams: { return_url: window.location.href } });
      if (result.error) {
        setError(result.error.message ?? "Payment could not be completed. Please check your details.");
        setProcessing(false);
      }
    } catch { setError("Unable to process payment. Checking its status…"); }
    finally { submitting.current = false; }
  }
  return <form onSubmit={pay} className="mt-5 space-y-4" aria-label="Online payment">
    <p className="text-sm text-muted-foreground">Your court is held until {new Date(holdExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Complete payment before this time.</p>
    {!terminal && <div inert={disabled}><PaymentElement onReady={() => setReady(true)} onLoadError={() => setError("Unable to load payment details. Please try again later.")} /></div>}
    <p role={error ? "alert" : "status"} className={`min-h-6 text-sm ${error ? "text-danger" : "text-muted-foreground"}`}>
      {error || (processing ? "Processing payment and waiting for booking confirmation…" : "")}
    </p>
    {!terminal && <Button type="submit" disabled={disabled || !stripe || !elements || !ready || processing} aria-busy={processing}>
      {processing ? "Processing…" : "Pay and confirm booking"}
    </Button>}
  </form>;
}
