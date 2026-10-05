import "server-only";

import { z } from "zod";
import type { PaymentProviderConfiguration } from "./types";

// NETOPIA API v2 merchant configuration, isolated from booking/payment workflows.
const configurationSchema = z.object({
  apiKey: z.string().trim().min(1),
  posSignature: z.string().trim().min(1),
  environment: z.enum(["sandbox", "live"]),
});

export const netopiaConfiguration: PaymentProviderConfiguration = {
  id: "netopia",
  isConfigured: () => configurationSchema.safeParse({ apiKey: process.env.NETOPIA_API_KEY,
    posSignature: process.env.NETOPIA_POS_SIGNATURE, environment: process.env.NETOPIA_ENVIRONMENT }).success,
};
