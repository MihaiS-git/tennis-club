import "server-only";
import Stripe from "stripe";
import { stripeConfig } from "./config";

export function stripeClient() {
  const secretKey = stripeConfig().secretKey;
  if (process.env.STRIPE_TEST_API_URL) {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.TEST_SUPABASE_PROJECT !== "tennis-club-tests" || database.hostname !== "127.0.0.1"
      || database.port !== "55322" || secretKey !== "sk_test_IsolatedFixture"
      || process.env.STRIPE_TEST_API_URL !== "http://127.0.0.1:3111")
      throw new StripeProviderError("configuration");
    return new Stripe(secretKey, { host: "127.0.0.1", port: 3111, protocol: "http", maxNetworkRetries: 0, timeout: 3000 });
  }
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15_000 });
}

export class StripeProviderError extends Error {
  constructor(readonly kind: "configuration" | "creation" | "signature" | "cancellation" | "capture" | "refund") {
    super("Payment service unavailable.");
  }
}
