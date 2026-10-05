import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { paymentProviderSchema, type PaymentProvider, type PaymentSettings } from "./domain";
import { configuredPaymentProvider, paymentProviderStatuses } from "./providers";

type Reader = Awaited<ReturnType<typeof createClient>>;
type Writer = ReturnType<typeof createBookingWriter>;
const settingsSchema = z.object({ active_provider: paymentProviderSchema.nullable() });

async function readSelectedProvider(client: Reader | Writer) {
  const result = await client.from("payment_provider_settings").select("active_provider").eq("id", true).single();
  const parsed = settingsSchema.safeParse(result.data);
  if (result.error || !parsed.success) {
    logger.error({ event: "payments.settings_read_failed", code: result.error?.code }, "Payment settings read failed");
    throw new Error("Unable to load payment settings.");
  }
  return parsed.data.active_provider;
}

// Returns only an identifier. There is no fallback to another configured provider.
export async function activeOnlinePaymentProvider(writer?: Writer): Promise<PaymentProvider | null> {
  return configuredPaymentProvider(await readSelectedProvider(writer ?? createBookingWriter()));
}

export async function readAdminPaymentSettings(reader?: Reader): Promise<PaymentSettings> {
  const client = reader ?? await createClient();
  await requireActiveAdmin(client);
  return { activeProvider: await readSelectedProvider(client), providers: paymentProviderStatuses() };
}

export type PaymentSettingsResult = { ok: true; activeProvider: PaymentProvider | null }
  | { ok: false; message: string };

export async function selectActivePaymentProvider(input: unknown, reader?: Reader, writer?: Writer): Promise<PaymentSettingsResult> {
  const client = reader ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = z.strictObject({ provider: paymentProviderSchema.nullable() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Select a supported payment provider." };
  const provider = parsed.data.provider;
  if (provider && !configuredPaymentProvider(provider))
    return { ok: false, message: "Complete this provider’s server configuration before activating it." };
  const result = await (writer ?? createBookingWriter()).rpc("select_payment_provider", {
    p_provider: provider, p_actor_user_id: actor.userId,
  });
  if (result.error) {
    logger.error({ event: "payments.provider_selection_failed", actorId: actor.userId, provider, code: result.error.code }, "Payment provider selection failed");
    return { ok: false, message: "Unable to change the payment provider. Try again." };
  }
  logger.info({ event: "payments.provider_selected", actorId: actor.userId, provider }, "Active payment provider selected");
  return { ok: true, activeProvider: provider };
}
