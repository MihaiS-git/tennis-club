import { appendFileSync } from "node:fs";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { DataSource, EntityManager } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { listOwnerActivityBatch } from "@/lib/db/repositories/court-activity.repository";
import { assertTestEnvironment } from "../local/environment.mjs";
import { insertBookingRecords } from "../local/booking-fixtures";
import { localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";

let database: DataSource;
let actorId: string;
beforeAll(async () => {
  assertTestEnvironment();
  actorId = await ensureIntegrationAdminAnchor(localFixtureClient());
  database = await getDataSource();
});
afterAll(async () => { await database?.destroy(); });

// All synthetic rows, including bulk copies of a valid immutable snapshot, roll
// back. No trigger bypass, migration, persistent fixture, or new index is needed.
async function seed(manager: EntityManager, count: number) {
  const locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
  await manager.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1::uuid,'Pagination',$1::text,'UTC')", [locationId]);
  await manager.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Court','court','hard','outdoor')", [courtId, locationId]);
  await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute)
    VALUES($1,$2,'1700-01-01',600,660)`, [reservationId, courtId]);
  await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: actorId,
    customer_name: "Historical snapshot", customer_email: "pagination@example.test", customer_phone: "123",
    total_amount_minor: 1000, currency: "RON", cancellation_notice_minutes: 120 });
  await manager.query(`CREATE TEMP TABLE activity_fixture_ids ON COMMIT DROP AS
    SELECT n,gen_random_uuid() AS reservation_id,gen_random_uuid() AS booking_id,gen_random_uuid() AS revision_id,
      gen_random_uuid() AS direct_id FROM generate_series(1,$1::int) n`, [count]);
  await manager.query(`INSERT INTO public.court_reservations
    SELECT (jsonb_populate_record(NULL::public.court_reservations,to_jsonb(r)||jsonb_build_object(
      'id',f.reservation_id,'booking_date',date '1700-01-01'+f.n))).*
    FROM public.court_reservations r CROSS JOIN activity_fixture_ids f WHERE r.id=$1`, [reservationId]);
  await manager.query(`INSERT INTO public.checkout_records
    SELECT (jsonb_populate_record(NULL::public.checkout_records,to_jsonb(b)||jsonb_build_object(
      'id',f.booking_id,'reservation_id',f.reservation_id,'current_revision_id',f.revision_id))).*
    FROM public.checkout_records b CROSS JOIN activity_fixture_ids f WHERE b.id=$1`, [bookingId]);
  await manager.query(`INSERT INTO public.booking_revisions
    SELECT (jsonb_populate_record(NULL::public.booking_revisions,to_jsonb(v)||jsonb_build_object(
      'id',f.revision_id,'booking_id',f.booking_id,'booking_date',date '1700-01-01'+f.n))).*
    FROM public.booking_revisions v CROSS JOIN activity_fixture_ids f WHERE v.booking_id=$1`, [bookingId]);
  await manager.query(`INSERT INTO public.court_reservations
    SELECT (jsonb_populate_record(NULL::public.court_reservations,to_jsonb(r)||jsonb_build_object(
      'id',f.direct_id,'created_by_user_id',$2::uuid,'booking_date',date '1400-01-01'+f.n))).*
    FROM public.court_reservations r CROSS JOIN activity_fixture_ids f WHERE r.id=$1`, [reservationId, actorId]);
  await manager.query("INSERT INTO public.bookings(id,confirmation_revision_id) SELECT booking_id,revision_id FROM activity_fixture_ids");
  await manager.query("SET CONSTRAINTS ALL IMMEDIATE");
  for (const table of ["checkout_records", "bookings", "booking_revisions", "court_reservations", "courts", "locations"]) {
    await manager.query(`ANALYZE public.${table}`);
  }
  return actorId;
}

if (process.env.ACTIVITY_BENCHMARK === "1") test("measure activity batch plans on isolated PostgreSQL", async () => {
  for (const count of [1000, 10000, 30000]) {
    const runner = database.createQueryRunner();
    await runner.startTransaction();
    try {
      const actorId = await seed(runner.manager, count);
      for (const kind of ["booking", "reservation"] as const) {
        let sql = "";
        const capture = vi.spyOn(runner.manager, "query").mockImplementation(async statement => { sql = statement; return []; });
        await listOwnerActivityBatch(runner.manager, { actorId, kind, cancelled: false, scope: "history",
          earliestDate: "2026-10-01", latestDate: "2026-10-04", afterId: null, limit: 1000 });
        capture.mockRestore();
        const alias = kind === "booking" ? "b" : "r";
        const offsetSql = sql.replace(" LIMIT $4", " LIMIT $4 OFFSET $5");
        const seekSql = sql.replace(`ORDER BY ${alias}.id`, `AND ${alias}.id > $5::uuid ORDER BY ${alias}.id`).replace(" OFFSET $5", "");
        for (const mode of ["offset", "seek"] as const) {
          let cursor = "00000000-0000-0000-0000-000000000000";
          let offset = 0, queries = 0;
          const started = performance.now();
          for (;;) {
            const rows: { row: { id: string } }[] = await runner.manager.query(mode === "offset" ? offsetSql : seekSql,
              [actorId, kind === "booking" ? "confirmed" : "active", "2026-10-04", 1000, mode === "offset" ? offset : cursor]);
            queries++;
            offset += rows.length;
            if (rows.length < 1000) break;
            cursor = rows[rows.length - 1].row.id;
          }
          appendFileSync("/tmp/tennis-activity-plans.jsonl", JSON.stringify({ count, kind, mode, scan: true,
            queries, returned: offset, elapsedMs: performance.now() - started }) + "\n");
        }
        for (const offset of [0, Math.floor(count / 2000) * 1000, Math.floor((count - 1) / 1000) * 1000]) {
          const [{ id: cursor }]: { id: string }[] = await runner.manager.query(`SELECT id FROM public.${kind === "booking" ? "checkout_records" : "court_reservations"}
            WHERE ${kind === "booking" ? "account_user_id" : "created_by_user_id"}=$1 ORDER BY id OFFSET $2 LIMIT 1`, [actorId, Math.max(0, offset - 1)]);
          for (const mode of ["offset", "seek"] as const) {
            const times: number[] = [];
            let plan;
            for (let repeat = 0; repeat < 3; repeat++) {
              const [result] = await runner.manager.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${mode === "offset" ? offsetSql : seekSql}`,
                [actorId, kind === "booking" ? "confirmed" : "active", "2026-10-04", 1000,
                  mode === "offset" ? offset : offset ? cursor : "00000000-0000-0000-0000-000000000000"]);
              plan = result["QUERY PLAN"][0];
              times.push(plan["Execution Time"]);
            }
            appendFileSync("/tmp/tennis-activity-plans.jsonl", JSON.stringify({ count, kind, offset, mode, times, plan }) + "\n");
          }
        }
      }
    } finally { await runner.rollbackTransaction(); await runner.release(); }
  }
}, 240000);


test("UUID continuation visits every owner row once across real database batches", async () => {
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try {
    const actorId = await seed(runner.manager, 2000);
    for (const kind of ["booking", "reservation"] as const) {
      const expected: { id: string }[] = await runner.manager.query(`SELECT id FROM public.${kind === "booking" ? "checkout_records" : "court_reservations"}
        WHERE ${kind === "booking" ? "account_user_id" : "created_by_user_id"}=$1
        AND status=$2 ORDER BY id`, [actorId, kind === "booking" ? "confirmed" : "active"]);
      const ids: string[] = [];
      let afterId: string | null = null;
      for (;;) {
        const rows = z.array(z.object({ id: z.uuid() }).passthrough()).parse(await listOwnerActivityBatch(runner.manager,
          { actorId, kind, cancelled: false, scope: "history", earliestDate: "2026-10-01", latestDate: "9999-12-31", afterId, limit: 1000 }));
        ids.push(...rows.map(row => row.id));
        if (rows.length < 1000) break;
        afterId = rows[rows.length - 1].id;
      }
      expect(ids).toEqual(expected.map(row => row.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(2000);
    }
  } finally { await runner.rollbackTransaction(); await runner.release(); }
}, 30000);
