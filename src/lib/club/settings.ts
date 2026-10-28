import "server-only";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { createClient } from "@/lib/supabase/server";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import { readClubContact, readClubSettings, writeClubContact, writeClubSettings } from "@/lib/db/repositories/club-settings.repository";
import { brevoConfig, sendBrevoEmail } from "@/lib/notifications/brevo";
import { clubContactSchema, clubSettingsSchema, type ClubContact, type ClubSettings } from "./schema";

export async function readAdminClubSettings() {
  await requireActiveAdmin();
  return readClubSettings((await getDataSource()).manager);
}

export async function saveClubSettings(input: unknown): Promise<{ ok: true; settings: ClubSettings } | { ok: false; message: string }> {
  const actor = await requireActiveAdmin();
  const parsed = clubSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Enter a valid official email address and a sender name of 1–100 characters." };
  try {
    await inTransaction(async manager => {
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Active Admin access required");
      await writeClubSettings(manager, parsed.data);
    });
    return { ok: true, settings: parsed.data };
  } catch {
    return { ok: false, message: "Unable to save Club settings. Try again." };
  }
}

export async function readAdminClubContact() {
  await requireActiveAdmin();
  return readClubContact((await getDataSource()).manager);
}

export async function saveClubContact(input: unknown): Promise<{ ok: true; contact: ClubContact } | { ok: false; message: string }> {
  const actor = await requireActiveAdmin();
  const parsed = clubContactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Enter a valid email address and a telephone number of 6–15 digits, or leave them empty." };
  try {
    await inTransaction(async manager => {
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Active Admin access required");
      await writeClubContact(manager, parsed.data);
    });
    return { ok: true, contact: parsed.data };
  } catch {
    return { ok: false, message: "Unable to save contact details. Try again." };
  }
}

export async function sendClubTestEmail(): Promise<{ ok: boolean; message: string }> {
  const client = await createClient();
  const actor = await requireActiveAdmin(client);
  const { data, error } = await client.auth.getUser();
  const user = data.user;
  if (error || !user || user.id !== actor.userId || !user.email_confirmed_at || !user.email) {
    return { ok: false, message: "A verified Admin email address is required." };
  }
  try {
    const settings = await inTransaction(async manager => {
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Active Admin access required");
      return readClubSettings(manager, "pessimistic_read");
    });
    if (!settings.emailsEnabled || !clubSettingsSchema.safeParse(settings).success)
      return { ok: false, message: "Save sender configuration and enable transactional emails first." };
    const config = brevoConfig(settings);
    const result = await sendBrevoEmail(config, { id: randomUUID(), recipientEmail: user.email,
      subject: "Tennis Club test email", bodyText: "This is a test of the club email configuration.",
      bodyHtml: "<p>This is a test of the club email configuration.</p>" });
    if (!result.ok) {
      logger.warn({ event: "club.test_email_failed", actorId: actor.userId, error: result.error }, "Club test email failed");
      return { ok: false, message: testEmailFailureReason(result.error) };
    }
    logger.info({ event: "club.test_email_accepted", actorId: actor.userId, messageId: result.messageId,
      mode: config.mode }, "Club test email accepted by Brevo");
    return { ok: true, message: "Test email submitted to Brevo. Check your inbox." };
  } catch (error) {
    logger.error({ event: "club.test_email_failed", actorId: actor.userId, error }, "Club test email failed");
    return { ok: false, message: "Unable to send the test email. Check server email configuration." };
  }
}

function testEmailFailureReason(error: string): string {
  if (/^Brevo HTTP 401(?::|$)/.test(error)) return "Brevo authentication failed. Check the configured API key.";
  if (/^Brevo HTTP 403(?::|$)/.test(error)) return "Brevo denied the request. Check sender authorization and account permissions.";
  if (/^Brevo HTTP 429(?::|$)/.test(error)) return "Brevo is receiving too many requests. Try again later.";
  if (/^Brevo HTTP 5\d{2}(?::|$)/.test(error)) return "Brevo is temporarily unavailable. Try again later.";
  if (/^Brevo HTTP 4\d{2}(?::|$)/.test(error)) return "Brevo rejected the email. Check the sender configuration and recipient address.";
  return "Unable to confirm email submission. Check your inbox and server email configuration.";
}
