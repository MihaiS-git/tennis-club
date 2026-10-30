import type { OnlineCheckout } from "@/lib/payments/domain";

// Resolves true only when the server confirmed the hold was released.
export function abandonUnusedCheckout(checkout: OnlineCheckout) {
  return fetch("/api/payments/checkout/abandon", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId: checkout.attemptId, token: checkout.token }),
    keepalive: true,
  }).then(async response => response.ok && (await response.json() as { released?: unknown }).released === true)
    // Server expiration remains authoritative if navigation loses the request.
    .catch(() => false);
}
