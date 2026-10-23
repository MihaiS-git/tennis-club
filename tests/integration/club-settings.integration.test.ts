import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { readClubSettings, writeClubSettings, emailDispatchAllowed } from "@/lib/db/repositories/club-settings.repository";
import { claimEmailDeliveries, completeEmailAttempt, insertEmailDelivery } from "@/lib/db/repositories/notifications.repository";

test("club settings round-trip; disable permanently suppresses pending/manual retries and claimed deliveries while preserving acceptance", async () => {
  const runner = (await getDataSource()).createQueryRunner();
  await runner.startTransaction();
  const manager = runner.manager;
  const settings = { officialEmail: "official@example.test", senderName: "Integration Club", emailsEnabled: true };
  const ids = Array.from({ length: 5 }, () => randomUUID());
  try {
    await writeClubSettings(manager, settings);
    expect(await readClubSettings(manager)).toEqual(settings);
    for (const [index, id] of ids.entries()) {
      await insertEmailDelivery(manager, { id, eventKey: `club-test:${id}`, recipientEmail: "guest@example.test",
        subject: "Fixture", bodyText: "Body", bodyHtml: "<p>Body</p>",
        status: index === 3 ? "accepted" : index === 4 ? "sandbox_accepted" : "pending",
        providerMessageId: index >= 3 ? `<accepted-${id}>` : null, attempts: index ? 1 : 0,
        lastError: index === 1 ? "Brevo HTTP 503" : null,
        nextAttemptAt: new Date(), lockedUntil: null, createdAt: new Date(), updatedAt: new Date() });
    }
    // Claim just our fixture using the guarded manual-rejection path.
    await manager.query("UPDATE public.email_deliveries SET last_error='Brevo HTTP 503' WHERE id=$1", [ids[2]]);
    const [claim] = await claimEmailDeliveries(manager, 1, null, ids[2]);
    expect(await emailDispatchAllowed(manager, claim.id)).toEqual(settings);
    await writeClubSettings(manager, { ...settings, emailsEnabled: false });
    expect(await emailDispatchAllowed(manager, claim.id)).toBeNull();
    await writeClubSettings(manager, settings);
    expect(await emailDispatchAllowed(manager, claim.id)).toBeNull();
    expect(await claimEmailDeliveries(manager, 1, null, ids[1])).toEqual([]);
    // In-flight results remain historical facts even if the switch changed meanwhile.
    expect(await completeEmailAttempt(manager, { id: claim.id, attempts: claim.attempts,
      lockedUntil: claim.lockedUntil, status: "accepted", providerMessageId: "<in-flight>",
      nextAttemptAt: new Date(), lastError: null })).toBe(true);
    const rows = await manager.query("SELECT id,status,provider_message_id,suppressed_at IS NOT NULL AS suppressed FROM public.email_deliveries WHERE id=ANY($1::uuid[])", [ids]);
    expect(rows).toHaveLength(5);
    expect(rows.find((row: { id: string }) => row.id === ids[0])).toMatchObject({ status: "pending", suppressed: true });
    expect(rows.find((row: { id: string }) => row.id === ids[2])).toMatchObject({ status: "accepted", provider_message_id: "<in-flight>", suppressed: true });
    expect(rows.find((row: { id: string }) => row.id === ids[3])).toMatchObject({ status: "accepted", suppressed: false });
    expect(rows.find((row: { id: string }) => row.id === ids[4])).toMatchObject({ status: "sandbox_accepted", suppressed: false });
    expect(await manager.query(`SELECT has_table_privilege('anon','public.club_settings','SELECT') AS anon,
      has_table_privilege('authenticated','public.club_settings','SELECT,INSERT,UPDATE,DELETE') AS authenticated`))
      .toEqual([{ anon: false, authenticated: false }]);
    await expect(manager.query("INSERT INTO public.club_settings (id) VALUES(false)")).rejects.toThrow();
  } finally {
    await runner.rollbackTransaction(); await runner.release();
  }
});
