import { isolateNotificationQueue } from "./booking-notification-fixtures";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import type { DataSource } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { enqueueBookingNotification } from "@/lib/notifications/booking-delivery";
import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
import { assertTestEnvironment } from "../local/environment.mjs";

let database: DataSource;
const prefix = `verification:${randomUUID()}:`;
let restoreQueue: () => Promise<void>;
beforeAll(async () => { assertTestEnvironment(); database = await getDataSource(); restoreQueue = await isolateNotificationQueue(database.manager); });
afterEach(async () => { await database.query("DELETE FROM public.booking_notification_deliveries WHERE event_key LIKE $1", [`${prefix}%`]); });
afterAll(async () => { try { await restoreQueue?.(); } finally { await database?.destroy(); } });
const event: BookingEmailEvent = { recipient: "recovery@example.test", event_kind: "confirmed", payload: {
  booking_id: randomUUID(), customer_name: "Recovery", location_name: "Test", timezone: "UTC",
  court_name: "Court", booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
  total_amount_minor: 5000, currency: "RON", previous: null,
} };
async function queued() {
  const key = prefix + randomUUID();
  await database.transaction(async manager => {
    await enqueueBookingNotification(manager, key, event);
    await enqueueBookingNotification(manager, key, event);
  });
  const [row]: { id: string }[] = await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key]);
  return row.id;
}
async function row(id: string) {
  const [result]: { attempts: number; delivered_at: Date | null; lease_token: string | null; last_error: string | null }[] =
    await database.query("SELECT attempts,delivered_at,lease_token,last_error FROM public.booking_notification_deliveries WHERE id=$1", [id]);
  return result;
}
function worker(mode: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", "--import=./scripts/ts-loader.mjs",
      "tests/local/notification-recovery-worker.ts", mode], { env: { ...process.env, LOG_LEVEL: "silent" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Worker timed out: ${output}`)); }, 25_000);
    child.on("error", reject);
    child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
const submissions = (output: string, id: string) => output.split("\n").filter(line => line.startsWith("BREVO ") && line.includes(id));

test("outbox rolls back with the state-change transaction and deduplicates committed event keys", async () => {
  const key = prefix + "rollback";
  await expect(database.transaction(async manager => {
    await enqueueBookingNotification(manager, key, event);
    throw new Error("interrupted before commit");
  })).rejects.toThrow("interrupted before commit");
  expect(await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key])).toEqual([]);
  const id = await queued();
  expect(await row(id)).toMatchObject({ attempts: 0, delivered_at: null });
});

test("temporary Brevo failure persists backoff and is retried successfully by a fresh process", async () => {
  const id = await queued();
  const first = await worker("temporary");
  expect(first.code, first.output).toBe(0);
  expect(submissions(first.output, id)).toHaveLength(1);
  expect(await row(id)).toMatchObject({ attempts: 1, delivered_at: null, lease_token: null, last_error: "delivery_unconfirmed" });
  expect(submissions((await worker("deliver")).output, id)).toHaveLength(0);
  await database.query("UPDATE public.booking_notification_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  const retry = await worker("deliver");
  expect(retry.code, retry.output).toBe(0);
  expect(submissions(retry.output, id)).toHaveLength(1);
  expect(await row(id)).toMatchObject({ attempts: 2, delivered_at: expect.any(Date), last_error: null });
});

test("crash after submission survives process death and lease expiry, preserving the provider idempotency key", async () => {
  const id = await queued();
  const crash = await worker("crash");
  expect(crash.code, crash.output).toBe(86);
  expect(submissions(crash.output, id)).toHaveLength(1);
  expect(await row(id)).toMatchObject({ attempts: 1, delivered_at: null, lease_token: expect.any(String) });
  expect(submissions((await worker("deliver")).output, id)).toHaveLength(0);
  await database.query("UPDATE public.booking_notification_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  const recovered = await worker("deliver");
  expect(recovered.code, recovered.output).toBe(0);
  expect(submissions(recovered.output, id), JSON.stringify({ recovered, row: await row(id) })).toHaveLength(1);
  expect(await row(id)).toMatchObject({ attempts: 2, delivered_at: expect.any(Date), lease_token: null });
});

test("two independent worker processes claim each pending delivery once across repeated cycles", async () => {
  const ids = await Promise.all([queued(), queued(), queued()]);
  const results = await Promise.all([worker("deliver"), worker("deliver")]);
  for (const result of results) expect(result.code, result.output).toBe(0);
  for (const id of ids) {
    expect(submissions(results.map(result => result.output).join("\n"), id), JSON.stringify({ results, row: await row(id) })).toHaveLength(1);
    expect(await row(id)).toMatchObject({ attempts: 1, delivered_at: expect.any(Date) });
  }
  const repeat = await worker("deliver");
  for (const id of ids) expect(submissions(repeat.output, id)).toHaveLength(0);
});

test("real instrumentation boot timer delivers committed pending work with no customer or Admin request", async () => {
  const id = await queued();
  const boot = await worker("scheduler");
  expect(boot.code, boot.output).toBe(0);
  expect(submissions(boot.output, id), JSON.stringify({ boot, row: await row(id) })).toHaveLength(1);
  expect(await row(id)).toMatchObject({ attempts: 1, delivered_at: expect.any(Date) });
}, 25_000);
