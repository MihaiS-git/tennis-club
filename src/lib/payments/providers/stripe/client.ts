import "server-only";
import Stripe from "stripe";
import { stripeConfig } from "./config";

export function stripeClient() {
  return new Stripe(stripeConfig().secretKey, { maxNetworkRetries: 2, timeout: 15_000 });
}

export class StripeProviderError extends Error {
  constructor(readonly kind: "configuration" | "creation" | "signature" | "cancellation" | "refund") {
    super("Payment service unavailable.");
  }
}
