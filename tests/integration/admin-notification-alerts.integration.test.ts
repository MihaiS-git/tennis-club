import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { DataSource, EntityManager } from "typeorm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { claimDueBookingNotification, hasAdminNotificationAlerts, listAdminBookingNotifications,
  recordBookingNotificationDelivery } from "@/lib/db/repositories/booking-notifications.repository";
import { readNotificationIndicators } from "@/lib/notifications/financial-notices";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { assertTestEnvironment } from "../local/environment.mjs";
import { insertBookingRecords } from "../local/booking-fixtures";

const service = localFixtureClient();
const userIds: string[] = [];
let database: DataSource;

beforeAll(async () => {
  assertTestEnvironment();
  database = await getDataSource();
});
afterAll(async () => {
  try { await cleanupAuthFixtures(service, userIds); }
  finally { await database?.destroy(); }
});

async function insertDelivery(manager: EntityManager, bookingId: string | null = null) {
  const id = randomUUID();
  await manager.query(`INSERT INTO public.booking_notification_deliveries (id,event_key,message,booking_id)
    VALUES ($1,$2,$3::jsonb,$4)`, [id, `admin-alert-test:${id}`,
    JSON.stringify({ to: "alert@example.test", subject: "Alert fixture", text: "Notification detection fixture" }), bookingId]);
  return id;
}

// Isolate the global EXISTS without changing any persisted pre-existing records.
// All fixture writes and the temporary hiding of existing deliveries roll back.
async function isolatedRead(run: (manager: EntityManager, id: string) => Promise<void>) {
  const runner = database.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.manager.query("UPDATE public.booking_notification_deliveries SET delivered_at=clock_timestamp() WHERE delivered_at IS NULL");
    expect(await hasAdminNotificationAlerts(runner.manager)).toBe(false);
    const locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
    await runner.manager.query(`INSERT INTO public.locations (id,name,slug,timezone,currency)
      VALUES ($1,'Alert fixture',$2,'UTC','RON')`, [locationId, `alert-${locationId}`]);
    await runner.manager.query(`INSERT INTO public.courts (id,location_id,name,slug,surface,environment)
      VALUES ($1,$2,'Court','court','clay','outdoor')`, [courtId, locationId]);
    await runner.manager.query(`INSERT INTO public.court_reservations (id,court_id,booking_date,starts_at_minute,ends_at_minute)
      VALUES ($1,$2,'2099-10-15',600,660)`, [reservationId, courtId]);
    await insertBookingRecords(runner.manager, { id: bookingId, reservation_id: reservationId, account_user_id: null,
      payment_method: "pay_at_club", customer_name: "Alert Customer", customer_email: "alert@example.test", customer_phone: "123",
      cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON", status: "confirmed" });
    await run(runner.manager, await insertDelivery(runner.manager, bookingId));
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

const states = {
  queued: "next_attempt_at=clock_timestamp()+interval '1 hour'",
  sending: "next_attempt_at='infinity',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 hour'",
  retrying: "attempts=1,last_error='unavailable',next_attempt_at=clock_timestamp()+interval '1 hour'",
  stopped: "attempts=8,last_error='rejected',next_attempt_at='infinity'",
  expiredLease: "attempts=8,last_error='rejected',next_attempt_at='infinity',lease_token=gen_random_uuid(),lease_until=clock_timestamp()-interval '1 hour'",
} as const;

for (const [name, assignment] of Object.entries(states)) {
  for (const financial of ["ordinary", "unacknowledged", "acknowledged"] as const) {
    test(`${name} ${financial}: alert agrees with Admin page state and financial count`, async () => {
      await isolatedRead(async (manager, id) => {
        await manager.query(`UPDATE public.booking_notification_deliveries SET ${assignment},
          requires_acknowledgement=$2,acknowledged_at=CASE WHEN $3 THEN clock_timestamp() END WHERE id=$1`,
        [id, financial !== "ordinary", financial === "acknowledged"]);
        const page = await listAdminBookingNotifications(manager, { search: "", state: null, subject: null,
          from: null, to: null, timezone: "Europe/Bucharest", sort: "created", direction: "desc", limit: 25, offset: 0 });
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]).toMatchObject({ id, state: name === "expiredLease" ? "stopped" : name });
        expect(page.unacknowledged_exceptions).toBe(financial === "unacknowledged" ? 1 : 0);
        expect(await hasAdminNotificationAlerts(manager)).toBe(
          page.rows[0].state === "stopped" || page.unacknowledged_exceptions > 0);
      });
    });
  }
}

test.each([false, true])("delivered notification is excluded even with financial exception=%s and stopped retry deadline", async important => {
  await isolatedRead(async (manager, id) => {
    await manager.query(`UPDATE public.booking_notification_deliveries SET delivered_at=clock_timestamp(),
      next_attempt_at='infinity',requires_acknowledgement=$2 WHERE id=$1`, [id, important]);
    expect(await hasAdminNotificationAlerts(manager)).toBe(false);
    const page = await listAdminBookingNotifications(manager, { search: "", state: null, subject: null,
      from: null, to: null, timezone: "Europe/Bucharest", sort: "created", direction: "desc", limit: 25, offset: 0 });
    expect(page).toMatchObject({ rows: [], total: 0, unacknowledged_exceptions: 0 });
  });
});

test("successful retry clears a stopped alert through the real claim/result persistence", async () => {
  await isolatedRead(async (manager, id) => {
    await manager.query(`UPDATE public.booking_notification_deliveries SET ${states.stopped} WHERE id=$1`, [id]);
    expect(await hasAdminNotificationAlerts(manager)).toBe(true);
    const token = randomUUID();
    expect(await claimDueBookingNotification(manager, token, id)).toMatchObject({ id, attempts: 9 });
    expect(await hasAdminNotificationAlerts(manager)).toBe(false); // The live sending lease takes precedence.
    await recordBookingNotificationDelivery(manager, { id, token, lastError: null, retrySeconds: 0 });
    expect(await hasAdminNotificationAlerts(manager)).toBe(false);
    expect(await manager.query("SELECT delivered_at IS NOT NULL AS delivered FROM public.booking_notification_deliveries WHERE id=$1", [id]))
      .toEqual([{ delivered: true }]);
  });
});

test("acknowledgement clears a financial alert, while stopped delivery independently keeps it visible", async () => {
  await isolatedRead(async (manager, id) => {
    await manager.query("UPDATE public.booking_notification_deliveries SET requires_acknowledgement=true WHERE id=$1", [id]);
    expect(await hasAdminNotificationAlerts(manager)).toBe(true);
    await manager.query("UPDATE public.booking_notification_deliveries SET acknowledged_at=clock_timestamp() WHERE id=$1", [id]);
    expect(await hasAdminNotificationAlerts(manager)).toBe(false);
    await manager.query(`UPDATE public.booking_notification_deliveries SET ${states.stopped} WHERE id=$1`, [id]);
    expect(await hasAdminNotificationAlerts(manager)).toBe(true);
  });
});

test.each(["member", "coach", "admin", "suspended admin", "unauthenticated"] as const)(
  "%s: authoritative account controls Admin query and response exposure", async kind => {
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    if (kind !== "unauthenticated") {
      const email = `admin-alert-${randomUUID()}@example.test`, password = "notification-test-password-123";
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const id = created.data.user!.id;
      userIds.push(id);
      if (kind !== "member") {
        const role = kind === "coach" ? "coach" : "admin";
        expect((await service.from("user_roles").insert({ user_id: id, role_code: role })).error).toBeNull();
      }
      if (kind === "suspended admin")
        expect((await service.from("users").update({ status: "suspended" }).eq("id", id)).error).toBeNull();
      expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    }
    const deliveryId = await insertDelivery(database.manager);
    await database.query("UPDATE public.booking_notification_deliveries SET next_attempt_at='infinity' WHERE id=$1", [deliveryId]);
    // Observe real SQL; no account, authorization or repository responses are mocked.
    const query = vi.spyOn(database.manager, "query");
    try {
      const indicators = await readNotificationIndicators(client);
      const adminQueries = query.mock.calls.filter(([sql]) => String(sql).includes("public.booking_notification_deliveries"));
      if (kind === "admin") {
        expect(indicators).toEqual({ unread: false, adminAlerts: true });
        expect(adminQueries).toHaveLength(1);
      } else {
        expect(indicators).toEqual({ unread: false });
        expect(adminQueries).toHaveLength(0);
      }
      if (kind === "suspended admin" || kind === "unauthenticated") expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      await database.query("DELETE FROM public.booking_notification_deliveries WHERE id=$1", [deliveryId]);
    }
  });
