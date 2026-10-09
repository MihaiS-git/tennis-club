import "server-only";

import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { lockProviderSelection, writeProviderSelection, findSelectedPaymentProvider } from "@/lib/db/repositories/payments.repository";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { paymentProviderSchema, type PaymentProvider, type PaymentSettings } from "./domain";
import { configuredPaymentProvider, paymentProviderStatuses } from "./providers";

type Reader = Awaited<ReturnType<typeof createClient>>;
// Returns only an identifier. There is no fallback to another configured provider.
export async function activeOnlinePaymentProvider(): Promise<PaymentProvider | null> {
  try {
    return configuredPaymentProvider(await findSelectedPaymentProvider((await getDataSource()).manager));
  } catch (error: unknown) {
    logger.error({ event: "payments.settings_read_failed", code: normalizeDatabaseError(error).sqlState }, "Payment settings read failed");
    throw new Error("Unable to load payment settings.");
  }
}

export async function readAdminPaymentSettings(reader?: Reader): Promise<PaymentSettings> {
  const client = reader ?? await createClient();
  await requireActiveAdmin(client);
  try {
    return { activeProvider: await findSelectedPaymentProvider((await getDataSource()).manager), providers: paymentProviderStatuses() };
  } catch (error: unknown) {
    logger.error({ event: "payments.settings_read_failed", code: normalizeDatabaseError(error).sqlState }, "Payment settings read failed");
    throw new Error("Unable to load payment settings.");
  }
}

export type PaymentSettingsResult = { ok: true; activeProvider: PaymentProvider | null }
  | { ok: false; message: string };

export async function selectActivePaymentProvider(input: unknown, reader?: Reader): Promise<PaymentSettingsResult> {
  const client = reader ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = z.strictObject({ provider: paymentProviderSchema.nullable() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Select a supported payment provider." };
  const provider = parsed.data.provider;
  if (provider && !configuredPaymentProvider(provider))
    return { ok: false, message: "Complete this provider’s server configuration before activating it." };
  try {
    await inTransaction(async (manager) => {
      const facts = await lockReservationActorFacts(manager, actor.userId);
      if (facts?.status !== "active" || !facts.roles.includes("admin")) throw new Error("Not authorized");
      const previous = await lockProviderSelection(manager);
      if (previous !== provider) await writeProviderSelection(manager, previous, provider, actor.userId);
    });
  } catch (error: unknown) {
    logger.error({ event: "payments.provider_selection_failed", actorId: actor.userId, provider,
      code: normalizeDatabaseError(error).sqlState }, "Payment provider selection failed");
    return { ok: false, message: "Unable to change the payment provider. Try again." };
  }
  logger.info({ event: "payments.provider_selected", actorId: actor.userId, provider }, "Active payment provider selected");
  return { ok: true, activeProvider: provider };
}
