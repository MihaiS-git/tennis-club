import type { OnlineCheckout } from "@/lib/payments/domain";

export function abandonUnusedCheckout(checkout: OnlineCheckout) {
  void fetch("/api/payments/checkout/abandon", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId: checkout.attemptId, token: checkout.token }),
    keepalive: true,
  }).catch(() => { /* Server expiration remains authoritative if navigation loses the request. */ });
}
