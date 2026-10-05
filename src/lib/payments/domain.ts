import { z } from "zod";

export const paymentMethodSchema = z.enum(["online", "pay_at_club"]);
export const paymentProviderSchema = z.enum(["stripe", "netopia"]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;
export const paymentHoldDurationSeconds = 10 * 60;
export type CheckoutLifecycle =
  | { status: "pending_payment"; holdExpiresAt: string }
  | { status: "confirmed"; holdExpiresAt: null };

// Safe presentation data only; provider credentials never belong in these types.
export type PaymentSettings = {
  activeProvider: PaymentProvider | null;
  providers: { id: PaymentProvider; configured: boolean }[];
};

export type PaymentPresentation = { kind: "stripe"; clientSecret: string; publishableKey: string };
export type OnlineCheckout = { attemptId: string; token: string; presentation: PaymentPresentation };
