import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { DataSource, EntityManager } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { assertTestEnvironment } from "../../local/environment.mjs";
import { cleanupBookingEvidence, insertBookingRecords, setAdjustmentExpiryFixture, setPaymentAttemptExpiryFixture } from "../../local/booking-fixtures";

// Every trigger a fixture helper may disable.
const bypassedTriggers = ["booking_adjustments_immutable", "payment_attempts_immutable", "booking_revisions_immutable",
  "refund_executions_immutable", "payment_provider_events_immutable", "payment_capture_receipts_immutable",
  "booking_financial_exceptions_immutable"];
let database: DataSource;
beforeAll(async () => { assertTestEnvironment(); database = await getDataSource(); });
afterAll(async () => { await database?.destroy(); });

async function triggerStates(manager: EntityManager = database.manager) {
  const rows: { tgname: string; tgenabled: string }[] = await manager.query(
    "SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1) ORDER BY tgname", [bypassedTriggers]);
  return Object.fromEntries(rows.map(row => [row.tgname, row.tgenabled]));
}
const allEnabled = Object.fromEntries([...bypassedTriggers].sort().map(name => [name, "O"]));

test("a transaction-scoped manager is accepted and the bypassed triggers are restored inside it", async () => {
  expect(await triggerStates()).toEqual(allEnabled);
  const locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID(), attemptId = randomUUID();
  try {
    // Committed first, as callers do: ALTER TABLE refuses tables with pending deferred-constraint events.
    await database.transaction(async manager => {
      await manager.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1,'Fixture guard',$2,'UTC')", [locationId, `fixture-guard-${locationId}`]);
      await manager.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Court','court','hard','outdoor')", [courtId, locationId]);
      await manager.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,'2099-10-15',600,660)",
        [reservationId, courtId]);
      await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, customer_name: "Customer",
        customer_email: "fixture-guard@example.test", customer_phone: "123", total_amount_minor: 5000, currency: "RON",
        cancellation_notice_minutes: 1440, payment_method: "online" });
      await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
        VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',now()+interval '10 minutes',now())`, [attemptId, bookingId, `pi_${attemptId}`]);
    });

    await database.transaction(async manager => {
      await setPaymentAttemptExpiryFixture(manager, attemptId, "2020-01-01T00:00:00Z");
      expect(await triggerStates(manager)).toEqual(allEnabled);
    });
    expect(await database.query("SELECT expires_at = '2020-01-01T00:00:00Z'::timestamptz AS moved FROM public.payment_attempts WHERE id=$1", [attemptId]))
      .toEqual([{ moved: true }]);
    await database.transaction(async manager => {
      await setAdjustmentExpiryFixture(manager, randomUUID(), "2020-01-01T00:00:00Z");
      expect(await triggerStates(manager)).toEqual(allEnabled);
    });
    await database.transaction(async manager => {
      await cleanupBookingEvidence(manager, { bookingIds: [bookingId] });
      expect(await triggerStates(manager)).toEqual(allEnabled);
    });
    expect(await database.query("SELECT count(*)::int AS count FROM public.bookings WHERE id=$1", [bookingId])).toEqual([{ count: 0 }]);
  } finally {
    await database.transaction(async manager => {
      await cleanupBookingEvidence(manager, { bookingIds: [bookingId] });
      await manager.query("DELETE FROM public.court_reservations WHERE id=$1", [reservationId]);
      await manager.query("DELETE FROM public.courts WHERE id=$1", [courtId]);
      await manager.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
    });
  }
  expect(await triggerStates()).toEqual(allEnabled);
});

test("a manager without an active transaction is rejected before any SQL runs", async () => {
  const pooled = database.manager;
  const idle = database.createQueryRunner();
  const committed = database.createQueryRunner();
  try {
    await committed.startTransaction();
    await committed.commitTransaction();
    for (const manager of [pooled, idle.manager, committed.manager]) {
      const query = vi.spyOn(manager, "query");
      try {
        for (const call of [
          () => setAdjustmentExpiryFixture(manager, randomUUID(), "2020-01-01T00:00:00Z"),
          () => setPaymentAttemptExpiryFixture(manager, randomUUID(), "2020-01-01T00:00:00Z"),
          () => cleanupBookingEvidence(manager, { bookingIds: [randomUUID()] }),
        ]) await expect(call()).rejects.toThrow("Trigger-bypass fixtures require an EntityManager bound to an active transaction.");
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    }
  } finally {
    await idle.release();
    await committed.release();
  }
  expect(await triggerStates()).toEqual(allEnabled);
});

test("a fixture that fails after disabling triggers leaves them enabled", async () => {
  // Fails inside the helper, after its DISABLE TRIGGER statements, from PostgreSQL itself.
  await expect(database.transaction(manager => setAdjustmentExpiryFixture(manager, randomUUID(), "not a timestamp")))
    .rejects.toThrow(/invalid input syntax for type timestamp/);
  expect(await triggerStates()).toEqual(allEnabled);
  await expect(database.transaction(manager => setPaymentAttemptExpiryFixture(manager, "not-a-uuid", "2020-01-01T00:00:00Z")))
    .rejects.toThrow(/invalid input syntax for type uuid/);
  expect(await triggerStates()).toEqual(allEnabled);

  // Teardown failing midway: six DISABLE statements issued, five triggers still disabled.
  const statements: string[] = [];
  await expect(database.transaction(async manager => {
    const query = manager.query.bind(manager);
    vi.spyOn(manager, "query").mockImplementation(async (sql, parameters) => {
      statements.push(sql);
      if (sql.startsWith("DELETE FROM public.payment_attempts")) {
        expect(await query("SELECT tgname FROM pg_trigger WHERE tgname = ANY($1) AND tgenabled = 'D'", [bypassedTriggers])).toHaveLength(5);
        throw new Error("injected teardown failure");
      }
      return query(sql, parameters);
    });
    await cleanupBookingEvidence(manager, { bookingIds: [randomUUID()] });
  })).rejects.toThrow("injected teardown failure");
  expect(statements.filter(sql => sql.includes("DISABLE TRIGGER"))).toHaveLength(6);
  expect(await triggerStates()).toEqual(allEnabled);
});
