"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { Button } from "@/components/button";
import type { CheckoutPaymentStatus, OnlineCheckout } from "@/lib/payments/domain";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import type { LocationCurrency } from "@/lib/pricing/money";
import { readCheckoutStatus } from "./checkout-status";

type Props = { confirmationMessage?: string; checkout: OnlineCheckout; holdExpiresAt: string; disabled?: boolean;
  onPaymentStatus?: (status: CheckoutPaymentStatus) => void;
  onConfirmed: (amount: number, currency: LocationCurrency, policy: ConfirmedCancellationPolicy | null) => void };

export function OnlinePayment(props: Props) {
  const stripe = useMemo(() => loadStripe(props.checkout.presentation.publishableKey), [props.checkout.presentation.publishableKey]);
  return <Elements key={props.checkout.attemptId} stripe={stripe} options={{ clientSecret: props.checkout.presentation.clientSecret,
    appearance: { theme: "stripe", variables: { borderRadius: "8px" } } }}>
    <PaymentForm {...props} />
  </Elements>;
}

function PaymentForm({ checkout, holdExpiresAt, onConfirmed, onPaymentStatus, disabled = false, confirmationMessage = "Booking confirmed." }: Props) {
  const stripe = useStripe(), elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<CheckoutPaymentStatus>("pending");
  const [message, setMessage] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [ready, setReady] = useState(false);
  const submitting = useRef(false);
  const processingStarted = useRef<number | null>(null);
  const notification = useRef<string | number | undefined>(undefined);
  const finished = useRef(false);
  const uncertain = useRef(false);
  const callbacks = useRef({ onConfirmed, onPaymentStatus });
  const generation = useRef(0);
  useEffect(() => { callbacks.current = { onConfirmed, onPaymentStatus }; }, [onConfirmed, onPaymentStatus]);


  useEffect(() => {
    finished.current = false;
    generation.current += 1;
    let disposed = false, busy = false, expiredLocally = false;
    let request: AbortController | undefined;
    function showStatus(status: CheckoutPaymentStatus, text: string) {
      setPaymentStatus(status); setMessage(text);
      if (status !== "pending") setFieldError("");
      callbacks.current.onPaymentStatus?.(status);
    }
    function unknown(text: string) {
      uncertain.current = true;
      setProcessing(false);
      showStatus("unknown", text);
      notification.current = toast.warning(text, { id: notification.current });
      processingStarted.current = null;
    }
    async function check() {
      if (busy || disposed || finished.current) return;
      busy = true;
      request = new AbortController();
      const timeout = window.setTimeout(() => request?.abort(), 10_000);
      try {
        const result = await readCheckoutStatus({ attemptId: checkout.attemptId, token: checkout.token }, request.signal);
        if (disposed || finished.current) return;
        if (!result.ok) { unknown(result.message + " You may close this window. Do not pay again yet."); return; }
        if (result.status === "confirmed") {
          finished.current = true;
          processingStarted.current = null;
          showStatus("succeeded", confirmationMessage);
          toast.success(confirmationMessage, { id: notification.current });
          notification.current = undefined;
          callbacks.current.onConfirmed(result.totalAmountMinor, result.currency, result.cancellationPolicy);
          return;
        }
        const state = result.paymentStatus;
        if (result.status !== "pending_payment" || state === "refund_pending" || state === "refund_failed" || state === "refunded") {
          uncertain.current = true;
          processingStarted.current = null; setProcessing(false);
          const text = state === "refund_failed" ? "The booking is cancelled, but the refund failed. Contact the club; do not pay again yet."
            : state === "refund_pending" ? "Your booking was not confirmed. A captured payment needs a refund; do not pay again until it is resolved."
            : state === "refunded" ? "Payment refunded. This booking is cancelled."
            : result.paymentUncertain ? "This checkout has ended, but the payment outcome is still uncertain. You may close this window; do not pay again yet."
            : state === "cancelled" ? "Payment cancelled. The court hold has been released."
            : "This checkout has expired or ended. Payment cannot be started here.";
          showStatus(state === "processing" || state === "unknown" ? "unknown" : state, text);
          if (notification.current !== undefined) {
            if (state === "refund_failed" || state === "failed") toast.error(text, { id: notification.current });
            else toast.info(text, { id: notification.current });
          }
          notification.current = undefined;
          // Keep checking uncertain and refund outcomes without a loading toast.
          if (!result.paymentUncertain && state !== "refund_pending") finished.current = true;
        } else if (state === "unknown") {
          if (!uncertain.current) unknown("Unable to establish the payment outcome. You may close this window; do not pay again yet.");
        } else if (processingStarted.current === null && !uncertain.current) {
          if (state === "processing") {
            processingStarted.current = Date.now(); setProcessing(true);
            showStatus(state, "Payment is processing. You may close this window; do not pay again yet.");
            notification.current = toast.loading("Processing payment and waiting for booking confirmation…", { id: notification.current });
          } else showStatus(state, "");
        }
      } catch {
        if (!disposed && !finished.current && !uncertain.current)
          unknown("Unable to check payment. You may close this window; do not pay again yet.");
      } finally { window.clearTimeout(timeout); busy = false; }
    }
    function expired() {
      if (disposed || finished.current) return;
      uncertain.current = true; setProcessing(false);
      processingStarted.current = null;
      showStatus("expired", "The checkout hold has expired. Any payment already submitted is still being checked. You may close this window; do not pay again yet.");
      if (notification.current !== undefined) toast.dismiss(notification.current);
      notification.current = undefined;
      void check();
    }
    const expires = window.setInterval(() => {
      if (!expiredLocally && Date.now() >= new Date(holdExpiresAt).getTime()) {
        expiredLocally = true; expired();
      }
    }, 250);
    // Stripe and Server Actions cannot be aborted reliably. Bound the loading
    // notification independently and ignore late responses after stop/dismissal.
    const loadingTimer = window.setInterval(() => {
      if (processingStarted.current !== null && Date.now() - processingStarted.current >= 30_000
        && !disposed && !finished.current)
        unknown("Payment is taking longer than expected. You may close this window; do not pay again yet.");
    }, 250);
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      disposed = true; finished.current = true;
      request?.abort();
      window.clearInterval(timer); window.clearInterval(loadingTimer); window.clearInterval(expires);
      processingStarted.current = null;
      if (notification.current !== undefined) toast.dismiss(notification.current);
      generation.current += 1;
    };
    // Refs keep current callbacks; this lifecycle belongs to one checkout only.
  }, [checkout.attemptId, checkout.token, holdExpiresAt, confirmationMessage]);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || submitting.current || finished.current || disabled
      || processing || paymentStatus !== "pending" || Date.now() >= new Date(holdExpiresAt).getTime()) return;
    const paymentGeneration = generation.current;
    submitting.current = true; processingStarted.current = Date.now(); setProcessing(true); setFieldError("");
    notification.current = toast.loading("Processing payment and waiting for booking confirmation…", { id: notification.current });
    try {
      const result = await stripe.confirmPayment({ elements, redirect: "if_required",
        confirmParams: { return_url: window.location.href } });
      if (finished.current || uncertain.current || paymentGeneration !== generation.current) return;
      if (result.error) {
        const text = result.error.message ?? "Payment could not be completed. Please check your details.";
        if (result.error.type === "validation_error" || result.error.type === "card_error") {
          if (result.error.type === "validation_error") { setFieldError(text); toast.dismiss(notification.current); }
          else toast.error(text, { id: notification.current });
          notification.current = undefined;
          processingStarted.current = null; setProcessing(false);
        } else {
          uncertain.current = true; processingStarted.current = null; setProcessing(false); setPaymentStatus("unknown");
          setMessage("Payment outcome is uncertain. You may close this window; do not pay again yet.");
          callbacks.current.onPaymentStatus?.("unknown");
          toast.warning("Payment outcome is uncertain. You may close this window; do not pay again yet.", { id: notification.current });
        }
      }
    } catch {
      if (!finished.current && !uncertain.current && paymentGeneration === generation.current) {
        uncertain.current = true; processingStarted.current = null; setProcessing(false); setPaymentStatus("unknown");
        const text = "Payment outcome is uncertain. You may close this window; do not pay again yet.";
        setMessage(text); callbacks.current.onPaymentStatus?.("unknown");
        toast.warning(text, { id: notification.current });
      }
    } finally { submitting.current = false; }
  }
  const canPay = paymentStatus === "pending" || paymentStatus === "processing";
  return <form onSubmit={pay} className="mt-5 space-y-4" aria-label="Online payment">
    {canPay && <p className="rounded-control border border-border bg-surface-muted p-3 text-sm text-foreground">Temporary hold deadline: <time dateTime={holdExpiresAt} className="font-semibold">{new Date(holdExpiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></p>}
    {canPay && <div inert={disabled || processing || paymentStatus !== "pending"} aria-describedby={fieldError ? "payment-field-error" : undefined}><PaymentElement onReady={() => { if (!finished.current) setReady(true); }} onLoadError={() => {
      if (!finished.current) toast.error("Unable to load payment details. Please try again later.", { id: `payment-element-${checkout.attemptId}` });
    }} /></div>}
    {fieldError && <p id="payment-field-error" role="alert" className="text-sm text-danger">{fieldError}</p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {canPay && <Button type="submit" disabled={disabled || !stripe || !elements || !ready || processing || paymentStatus !== "pending"} aria-busy={processing}>
      {processing ? "Processing…" : "Pay and confirm booking"}
    </Button>}
  </form>;
}
