import "server-only";

import { z } from "zod";
import type { PaymentProviderConfiguration } from "../types";

const configurationSchema = z.object({
  secretKey: z.string().trim().regex(/^sk_(test|live)_[A-Za-z0-9]+$/),
  publishableKey: z.string().trim().regex(/^pk_(test|live)_[A-Za-z0-9]+$/),
  webhookSecret: z.string().trim().regex(/^whsec_[A-Za-z0-9]+$/),
}).refine(value => value.secretKey.split("_")[1] === value.publishableKey.split("_")[1]);

export function stripeConfig() {
  return configurationSchema.parse({ secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET });
}

export const stripeConfiguration: PaymentProviderConfiguration = {
  id: "stripe",
  isConfigured: () => configurationSchema.safeParse({ secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET }).success,
};
