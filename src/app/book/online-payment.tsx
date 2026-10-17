"use client";

import { refreshNotificationUnread } from "@/components/notification-unread";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { AlertCircle, AlertTriangle, CheckCircle2, Clock, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/button";
import type { CheckoutPaymentStatus, OnlineCheckout } from "@/lib/payments/domain";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import type { LocationCurrency } from "@/lib/pricing/money";
import { readCheckoutStatus } from "./checkout-status";

// booking: a new booking checkout. modification: an additional payment for a
// change to a confirmed booking, whose original booking stays unchanged on failure.
type PaymentPurpose = "booking" | "modification";
type Props = { confirmationMessage?: string; checkout: OnlineCheckout; holdExpiresAt: string; disabled?: boolean;
  purpose?: PaymentPurpose;
  onPaymentStatus?: (status: CheckoutPaymentStatus) => void;
  onConfirmed: (amount: number, currency: LocationCurrency, policy: ConfirmedCancellationPolicy | null) => void };

const endedMessages: Record<PaymentPurpose, Record<"refund_failed" | "refund_pending" | "refunded" | "uncertain" | "cancelled" | "ended" | "expired", string>> = {
  booking: {
    refund_failed: "The booking is cancelled, but the refund failed. Contact the club; do not pay again yet.",
    refund_pending: "Your booking was not confirmed. A captured payment needs a refund; do not pay again until it is resolved.",
    refunded: "Payment refunded. This booking is cancelled.",
    uncertain: "This checkout has ended, but the payment outcome is still uncertain. You may close this window; do not pay again yet.",
    cancelled: "Payment cancelled. The court hold has been released.",
    ended: "This checkout has expired or ended. Payment cannot be started here.",
    expired: "The checkout hold has expired. Any payment already submitted is still being checked. You may close this window; do not pay again yet.",
  },
  modification: {
    refund_failed: "The change was not applied and the refund of this payment failed. Your original booking is unchanged. Contact the club; do not pay again yet.",
    refund_pending: "The change was not applied. Your original booking is unchanged and this payment is being refunded.",
    refunded: "The change was not applied. Your original booking is unchanged and this payment was refunded.",
    uncertain: "This modification has ended, but the payment outcome is still uncertain. Your original booking is unchanged. You may close this window; do not pay again yet.",
    cancelled: "Payment cancelled. Your original booking is unchanged.",
    ended: "This modification has expired or ended. Your original booking is unchanged.",
    expired: "The modification deadline has passed. Your original booking is unchanged. Any payment already submitted is still being checked; do not pay again yet.",
  },
};
// Status tones mirror the outcome: progress is neutral information, an ended
// checkout is muted, uncertain or refund outcomes need caution, failures need attention.
function statusPresentation(status: CheckoutPaymentStatus, processing: boolean) {
  if (status === "succeeded") return { Icon: CheckCircle2, spin: false, className: "border-success/30 bg-success-background text-success" };
  if (status === "failed" || status === "refund_failed") return { Icon: AlertCircle, spin: false, className: "border-danger/30 bg-danger-background text-danger" };
  if (status === "processing" && processing) return { Icon: Loader2, spin: true, className: "border-border bg-info-background text-info" };
  if (status === "pending") return { Icon: Clock, spin: false, className: "border-border bg-info-background text-info" };
  if (status === "cancelled" || status === "refunded") return { Icon: Info, spin: false, className: "border-border bg-surface-muted text-foreground" };
  return { Icon: AlertTriangle, spin: false, className: "border-border-strong bg-warning-background text-foreground" };
}
const processingMessage = "Processing payment and waiting for booking confirmation…";
const slowAuthenticationMessage = "Still waiting for card authentication. Complete it in your bank's window; do not pay again.";

export function OnlinePayment(props: Props) {
  const stripe = useMemo(() => loadStripe(props.checkout.presentation.publishableKey), [props.checkout.presentation.publishableKey]);
  return <Elements key={props.checkout.attemptId} stripe={stripe} options={{ clientSecret: props.checkout.presentation.clientSecret,
    appearance: { theme: "stripe", variables: { borderRadius: "8px" } } }}>
    <PaymentForm {...props} />
  </Elements>;
}

function PaymentForm({ checkout, holdExpiresAt, onConfirmed, onPaymentStatus, disabled = false, purpose = "booking",
  confirmationMessage = "Booking confirmed." }: Props) {
  const stripe = useStripe(), elements = useElements();
  // processing: the loading indicator only. authenticating: stripe.confirmPayment
  // (including 3D Secure) is in flight; Payment Element must stay mounted until it returns.
  const [processing, setProcessing] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<CheckoutPaymentStatus>("pending");
  const [message, setMessage] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [ready, setReady] = useState(false);
  const authenticatingRef = useRef(false);
  const processingStarted = useRef<number | null>(null);
  const notification = useRef<string | number | undefined>(undefined);
  const finished = useRef(false);
  const uncertain = useRef(false);
  const callbacks = useRef({ onConfirmed, onPaymentStatus });
  const generation = useRef(0);
  const messages = endedMessages[purpose];
  useEffect(() => { callbacks.current = { onConfirmed, onPaymentStatus }; }, [onConfirmed, onPaymentStatus]);


  useEffect(() => {
    finished.current = false;
    generation.current += 1;
    let disposed = false, busy = false, expiredLocally = false;
    let notificationOutcome = "";
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
    // Authentication may legitimately take minutes. Stop the loading indicator,
    // keep Stripe's authentication untouched and keep further submissions blocked.
    function slowAuthentication() {
      processingStarted.current = null;
      setProcessing(false);
      setMessage(slowAuthenticationMessage);
      notification.current = toast.info(slowAuthenticationMessage, { id: notification.current });
    }
    async function check() {
      if (busy || disposed || finished.current) return;
      busy = true;
      request = new AbortController();
      const timeout = window.setTimeout(() => request?.abort(), 10_000);
      try {
        const result = await readCheckoutStatus({ attemptId: checkout.attemptId, token: checkout.token }, request.signal);
        if (disposed || finished.current) return;
        // During authentication only a server-decided outcome matters; Stripe
        // reports the intent as processing until the customer completes it.
        if (!result.ok) {
          if (!authenticatingRef.current) unknown(result.message + " You may close this window. Do not pay again yet.");
          return;
        }
        if (result.status === "confirmed") {
          refreshNotificationUnread();
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
          const outcome = `${result.status}:${state}`;
          if (outcome !== notificationOutcome) {
            notificationOutcome = outcome;
            refreshNotificationUnread();
          }
          uncertain.current = true;
          processingStarted.current = null; setProcessing(false);
          const text = state === "refund_failed" ? messages.refund_failed
            : state === "refund_pending" ? messages.refund_pending
            : state === "refunded" ? messages.refunded
            : result.paymentUncertain ? messages.uncertain
            : state === "cancelled" ? messages.cancelled
            : messages.ended;
          showStatus(state === "processing" || state === "unknown" ? "unknown" : state, text);
          if (notification.current !== undefined) {
            if (state === "refund_failed" || state === "failed") toast.error(text, { id: notification.current });
            else toast.info(text, { id: notification.current });
          }
          notification.current = undefined;
          // Keep checking uncertain and refund outcomes without a loading toast.
          if (!result.paymentUncertain && state !== "refund_pending") finished.current = true;
        } else if (authenticatingRef.current) {
          // Payment Element owns this interaction until confirmPayment returns.
        } else if (state === "unknown") {
          if (!uncertain.current) unknown("Unable to establish the payment outcome. You may close this window; do not pay again yet.");
        } else if (processingStarted.current === null && !uncertain.current) {
          if (state === "processing") {
            processingStarted.current = Date.now(); setProcessing(true);
            showStatus(state, "Payment is processing. You may close this window; do not pay again yet.");
            notification.current = toast.loading(processingMessage, { id: notification.current });
          } else showStatus(state, "");
        }
      } catch {
        if (!disposed && !finished.current && !uncertain.current && !authenticatingRef.current)
          unknown("Unable to check payment. You may close this window; do not pay again yet.");
      } finally { window.clearTimeout(timeout); busy = false; }
    }
    function expired() {
      if (disposed || finished.current) return;
      uncertain.current = true; setProcessing(false);
      processingStarted.current = null;
      showStatus("expired", messages.expired);
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
    // An authentication in progress is never interrupted, only its spinner stops.
    const loadingTimer = window.setInterval(() => {
      if (processingStarted.current !== null && Date.now() - processingStarted.current >= 30_000
        && !disposed && !finished.current) {
        if (authenticatingRef.current) slowAuthentication();
        else unknown("Payment is taking longer than expected. You may close this window; do not pay again yet.");
      }
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
  }, [checkout.attemptId, checkout.token, holdExpiresAt, confirmationMessage, messages]);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || authenticatingRef.current || finished.current || disabled
      || processing || paymentStatus !== "pending" || Date.now() >= new Date(holdExpiresAt).getTime()) return;
    const paymentGeneration = generation.current;
    authenticatingRef.current = true; setAuthenticating(true);
    processingStarted.current = Date.now(); setProcessing(true); setFieldError("");
    notification.current = toast.loading(processingMessage, { id: notification.current });
    try {
      const result = await stripe.confirmPayment({ elements, redirect: "if_required",
        confirmParams: { return_url: window.location.href } });
      if (finished.current || uncertain.current || paymentGeneration !== generation.current) return;
      if (result.error) {
        const text = result.error.message ?? "Payment could not be completed. Please check your details.";
        // Failed or cancelled 3D Secure is a card_error: the same intent accepts another attempt.
        if (result.error.type === "validation_error" || result.error.type === "card_error") {
          if (result.error.type === "validation_error") { setFieldError(text); toast.dismiss(notification.current); }
          else toast.error(text, { id: notification.current });
          notification.current = undefined;
          processingStarted.current = null; setProcessing(false); setMessage("");
        } else {
          uncertain.current = true; processingStarted.current = null; setProcessing(false); setPaymentStatus("unknown");
          setMessage("Payment outcome is uncertain. You may close this window; do not pay again yet.");
          callbacks.current.onPaymentStatus?.("unknown");
          toast.warning("Payment outcome is uncertain. You may close this window; do not pay again yet.", { id: notification.current });
        }
      } else {
        // Authorized. Only the server's verified capture confirms; bound that wait anew.
        processingStarted.current = Date.now(); setProcessing(true); setMessage("");
        notification.current = toast.loading(processingMessage, { id: notification.current });
      }
    } catch {
      if (!finished.current && !uncertain.current && paymentGeneration === generation.current) {
        uncertain.current = true; processingStarted.current = null; setProcessing(false); setPaymentStatus("unknown");
        const text = "Payment outcome is uncertain. You may close this window; do not pay again yet.";
        setMessage(text); callbacks.current.onPaymentStatus?.("unknown");
        toast.warning(text, { id: notification.current });
      }
    } finally { authenticatingRef.current = false; setAuthenticating(false); }
  }
  const canPay = paymentStatus === "pending" || paymentStatus === "processing";
  // Never unmount Payment Element while Stripe authenticates, even after expiry
  // or an uncertain status; it is removed once confirmPayment has returned.
  const showPaymentElement = canPay || authenticating;
  const busy = processing || authenticating;
  const status = statusPresentation(paymentStatus, processing);
  return <form onSubmit={pay} className="mt-5 space-y-4" aria-label="Online payment">
    {canPay && <p className="flex items-start gap-2.5 rounded-control border border-border bg-background p-3 text-sm text-foreground"><Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" /><span>Temporary hold deadline: <time dateTime={holdExpiresAt} className="font-semibold tabular-nums">{new Date(holdExpiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></span></p>}
    {showPaymentElement && <div inert={disabled || busy || paymentStatus !== "pending"} aria-describedby={fieldError ? "payment-field-error" : undefined}><PaymentElement onReady={() => { if (!finished.current) setReady(true); }} onLoadError={() => {
      if (!finished.current) toast.error("Unable to load payment details. Please try again later.", { id: `payment-element-${checkout.attemptId}` });
    }} /></div>}
    {fieldError && <p id="payment-field-error" role="alert" className="flex items-start gap-2 text-sm font-medium text-danger"><AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{fieldError}</span></p>}
    {message && <p role="status" className={`flex items-start gap-2.5 rounded-control border px-3 py-2.5 text-sm font-medium ${status.className}`}>
      <status.Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${status.spin ? "motion-safe:animate-spin" : ""}`} /><span>{message}</span>
    </p>}
    {canPay && <Button type="submit" disabled={disabled || !stripe || !elements || !ready || busy || paymentStatus !== "pending"} aria-busy={busy}>
      {processing ? "Processing…" : authenticating ? "Waiting for authentication…" : "Pay and confirm booking"}
    </Button>}
  </form>;
}
