import type { EntityManager } from "typeorm";
import { z } from "zod";
import { assertTestEnvironment } from "../local/environment.mjs";
import { recoverBookingNotifications } from "@/lib/notifications/booking-recovery";

const messageSchema = z.object({ to: z.email(), subject: z.string(), text: z.string() });

export async function bookingNotifications(manager: EntityManager, bookingId: string) {
  assertTestEnvironment();
  // Financial tests inspect snapshots after an explicit scheduled projection pass.
  await recoverBookingNotifications();
  const id = z.uuid().parse(bookingId);
  const rows: unknown = await manager.query(`SELECT message FROM public.booking_notification_deliveries
    WHERE position($1 in message->>'text') > 0 ORDER BY created_at,id`, [`Booking reference: ${id}\n`]);
  return z.array(z.object({ message: messageSchema })).parse(rows).map(row => row.message);
}

// Worker tests share the disposable stack with other suites. Temporarily defer
// pre-existing deliveries so global bounded scans and crash injection reach only
// this suite's messages. Restore their original deadlines even if a test fails.
export async function isolateNotificationQueue(manager: EntityManager) {
  assertTestEnvironment();
  const rows: unknown = await manager.query(`WITH previous AS MATERIALIZED (
    SELECT id,next_attempt_at FROM public.booking_notification_deliveries WHERE delivered_at IS NULL FOR UPDATE
  ), deferred AS (UPDATE public.booking_notification_deliveries d SET next_attempt_at='infinity'
    FROM previous p WHERE d.id=p.id RETURNING d.id)
    SELECT p.id,p.next_attempt_at::text FROM previous p JOIN deferred d USING(id)`);
  const previous = z.array(z.object({ id: z.uuid(), next_attempt_at: z.string() })).parse(rows);
  return async () => {
    for (const row of previous) await manager.query(
      "UPDATE public.booking_notification_deliveries SET next_attempt_at=$2::timestamptz WHERE id=$1", [row.id,row.next_attempt_at]);
  };
}
