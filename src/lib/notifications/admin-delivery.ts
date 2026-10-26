import "server-only";

import { readClubSettings } from "@/lib/db/repositories/club-settings.repository";
import { z } from "zod";
import { profileContext } from "@/lib/profile/profile";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import { claimEmailDeliveries, findDeliveryBooking, findMessageDelivery, findNotificationAccounts } from "@/lib/db/repositories/notifications.repository";
import { brevoConfig } from "./brevo";
import { processClaim } from "./delivery";
import { deliveryCutoff, readableDeliveryError, retryEligibility } from "./delivery-retry";
import { resolveNotificationChannels } from "./policy";

export async function adminMessageDelivery(rawMessageId: unknown) {
  const { account } = await profileContext();
  if (account.state !== "active" || !account.roles.includes("admin")) return null;
  const id = z.uuid().safeParse(rawMessageId);
  if (!id.success) return null;
  const { manager } = await getDataSource();
  const delivery = await findMessageDelivery(manager, account.userId, id.data);
  if (!delivery) return null;
  const accounts = await findNotificationAccounts(manager, delivery.recipientEmail);
  let retry;
  try { retry = retryEligibility(delivery, deliveryCutoff()); }
  catch { retry = { eligible: false, reason: "Delivery cutoff configuration is invalid." }; }
  if (!resolveNotificationChannels(delivery.recipientEmail, accounts, "customer").email) {
    retry = { eligible: false, reason: "Admin and Coach accounts do not receive transactional emails." };
  }
  if (!(await readClubSettings(manager)).emailsEnabled) retry = { eligible: false, reason: "Club email delivery is disabled." };
  const bookingId = await findDeliveryBooking(manager, delivery.eventKey);
  return {
    bookingHref: bookingId ? `/admin/bookings/${bookingId}` : null,
    recipientEmail: delivery.recipientEmail, emailType: delivery.subject,
    status: delivery.status, failureReason: readableDeliveryError(delivery.lastError), attempts: delivery.attempts,
    // There is no attempt-history timestamp column. Completion updates this timestamp;
    // a later webhook can also update it, so expose that limitation explicitly.
    lastAttempt: delivery.attempts ? delivery.updatedAt.toISOString() : null,
    nextAutomaticRetry: delivery.status === "pending" && delivery.attempts < 5 && retry.eligible
      ? delivery.nextAttemptAt.toISOString() : null,
    retry,
  };
}

export async function retryMessageDelivery(rawMessageId: unknown): Promise<string> {
  const actor = await requireActiveAdmin();
  const messageId = z.uuid().parse(rawMessageId);
  const settings = await inTransaction(manager => readClubSettings(manager, "pessimistic_read"));
  if (!settings.emailsEnabled) return "Club email delivery is disabled.";
  const config = brevoConfig(settings);
  const notBefore = deliveryCutoff();
  const prepared = await inTransaction(async manager => {
    if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Active Admin access required");
    if (!(await readClubSettings(manager, "pessimistic_read")).emailsEnabled) return { message: "Club email delivery is disabled." };
    const delivery = await findMessageDelivery(manager, actor.userId, messageId, true);
    if (!delivery) return { message: "Delivery details unavailable." };
    const eligibility = retryEligibility(delivery, notBefore);
    if (!eligibility.eligible) return { message: eligibility.reason };
    const accounts = await findNotificationAccounts(manager, delivery.recipientEmail);
    if (!resolveNotificationChannels(delivery.recipientEmail, accounts, "customer").email) {
      return { message: "Admin and Coach accounts do not receive transactional emails." };
    }
    const [claim] = await claimEmailDeliveries(manager, 1, notBefore, delivery.id);
    return claim ? { claim } : { message: "This delivery is already processing or is no longer eligible." };
  });
  if (!prepared.claim) return prepared.message;
  // Claim commits before HTTP. Cron and other Admins see processing and cannot resend.
  const result = await processClaim(config, prepared.claim);
  if (result === "accepted") return "Accepted by Brevo. This does not confirm inbox delivery.";
  if (result === "sandboxAccepted") return "Accepted by Brevo in sandbox mode. No email was sent to the inbox.";
  if (result === "stale") return "Delivery state changed. Review the current details before taking further action.";
  return "The delivery attempt failed. Review the recorded failure reason and retry eligibility below.";
}
