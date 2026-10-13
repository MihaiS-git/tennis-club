import { checkoutStatusResponseSchema } from "@/lib/payments/domain";

// Status requests must not occupy Next.js's sequential Server Action queue:
// cancellation needs to dispatch even while a provider observation is delayed.
export async function readCheckoutStatus(access: { attemptId: string; token: string }, signal: AbortSignal) {
  const response = await fetch("/api/payments/checkout/status", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(access), cache: "no-store", signal,
  });
  return checkoutStatusResponseSchema.parse(await response.json());
}
