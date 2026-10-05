import "server-only";

import type { PaymentProvider } from "../domain";
import { stripeConfiguration } from "./stripe/config";
import { netopiaConfiguration } from "./netopia";
import type { PaymentProviderConfiguration } from "./types";

const configurations: Record<PaymentProvider, PaymentProviderConfiguration> = {
  stripe: stripeConfiguration,
  netopia: netopiaConfiguration,
};

export function paymentProviderStatuses() {
  return Object.values(configurations).map((configuration) => ({
    id: configuration.id, configured: configuration.isConfigured(),
  }));
}

export function configuredPaymentProvider(provider: PaymentProvider | null): PaymentProvider | null {
  return provider && configurations[provider].isConfigured() ? provider : null;
}

// Configuration is independent of adapter implementation. No fallback is possible.
const adapterLoaders: Partial<Record<PaymentProvider, () => Promise<import("./types").OnlinePaymentAdapter>>> = {
  stripe: async () => (await import("./stripe/adapter")).stripeAdapter,
};

export async function onlinePaymentAdapter(provider: PaymentProvider) {
  const load = adapterLoaders[provider];
  if (!load) throw new Error("Online payment is not supported by the selected provider yet.");
  return load();
}

export function supportsOnlineCheckout(provider: PaymentProvider | null) {
  return provider !== null && adapterLoaders[provider] !== undefined;
}
