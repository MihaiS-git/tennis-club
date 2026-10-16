import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { getDataSource } from "@/lib/db/data-source";
import { acknowledgeBookingNotice, listUnacknowledgedBookingNotices } from "@/lib/db/repositories/booking-notifications.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createClient>>;

// Important financial outcomes stay visible to the booking owner until they
// acknowledge them; a delivered email is not proof the customer read it. Other
// booking emails that could not be delivered are shown until they are delivered.
export async function listOwnFinancialNotices(client?: Client) {
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return [];
  let notices: Awaited<ReturnType<typeof listUnacknowledgedBookingNotices>>;
  try { notices = await listUnacknowledgedBookingNotices((await getDataSource()).manager, account.userId); }
  catch {
    logger.error({ event: "notifications.notice_read_failed", actorId: account.userId }, "Failed to load financial notices");
    return [];
  }
  // The stored text is the email body; drop its greeting in-app.
  return notices.map(({ email_failed: emailFailed, ...notice }) => ({ ...notice, emailFailed,
    text: notice.text.replace(/^Hello [^\n]*\n\n/, "") }));
}

export async function acknowledgeOwnFinancialNotice(id: unknown, client?: Client): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, message: "Choose a valid notice." };
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return { ok: false, message: "An active account is required." };
  try {
    // Ownership is enforced in the conditional update: another owner's notice is never changed.
    if (!await acknowledgeBookingNotice((await getDataSource()).manager, { id: parsed.data, accountUserId: account.userId }))
      return { ok: false, message: "This notice is no longer available." };
  } catch {
    logger.error({ event: "notifications.acknowledge_failed", actorId: account.userId }, "Failed to acknowledge financial notice");
    return { ok: false, message: "Unable to save. Try again." };
  }
  return { ok: true };
}
