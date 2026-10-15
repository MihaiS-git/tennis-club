import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { z } from "zod";
import { expect, test as base, type Page } from "@playwright/test";
import { cleanupBookingEvidence, insertBookingRecords, insertCaptureReceiptFixture } from "../local/booking-fixtures";
import { localServiceRoleKey } from "./helpers/supabase";

const providerUrl = "http://127.0.0.1:3111";
const evidenceSchema = z.object({
  payment: z.object({ id: z.string(), status: z.literal("succeeded"), amount_received: z.literal(5000) }),
  refunds: z.array(z.object({ id: z.string(), amount: z.number(), status: z.enum(["failed", "succeeded"]),
    metadata: z.object({ payment_refund_id: z.string(), refund_execution_id: z.string() }) })),
  dispatches: z.array(z.object({ idempotencyKey: z.string(), executionId: z.string() })),
});

type BookingFixture = { db: DataSource; userId: string; email: string; password: string;
  bookingId: string; reservationId: string; attemptId: string; paymentId: string; courtName: string };

// Both journeys share the existing Auth, immutable booking and guarded teardown helpers.
const test = base.extend<{ booking: BookingFixture }>({
  booking: async ({ request }, runFixture, testInfo) => {
    const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
    const email = `refund-browser-${randomUUID()}@example.test`, password = "Refund-browser-123";
    const locationId = randomUUID(), courtId = randomUUID(), bookingId = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
    const paymentId = `pi_original_${attemptId}`, courtName = `Refund Court ${courtId}`;
    let userId: string | undefined;
    try {
      const account = await auth.auth.admin.createUser({ email, password, email_confirm: true });
      expect(account.error).toBeNull();
      userId = account.data.user!.id;
      await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,'Refund Club',$2,'UTC','RON')", [locationId, `refund-${locationId}`]);
      await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,$3,'one','clay','outdoor')", [courtId, locationId, courtName]);
      await db.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,'2099-10-15',960,1020)", [reservationId, courtId]);
      await db.transaction(manager => insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: userId,
        customer_name: "Refund browser member", customer_email: email, customer_phone: "123", total_amount_minor: 5000, currency: "RON",
        payment_method: "online", status: "confirmed", cancellation_notice_minutes: 1440 }));
      const payment = await request.post(`${providerUrl}/fixture/payment`, { data: { id: paymentId, amount: 5000, attemptId,
        failRefund: testInfo.title.startsWith("Admin") } });
      expect(payment.ok()).toBe(true);
      expect(await payment.json()).toMatchObject({ id: paymentId, status: "succeeded", amount_received: 5000 });
      await db.transaction(async manager => {
        await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
          VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`, [attemptId, bookingId, paymentId]);
        await insertCaptureReceiptFixture(manager, { paymentAttemptId: attemptId, providerPaymentId: paymentId,
          providerCaptureId: paymentId, amountMinor: 5000, currency: "RON" });
      });
      await runFixture({ db, userId, email, password, bookingId, reservationId, attemptId, paymentId, courtName });
    } finally {
      try {
        await db.transaction(manager => cleanupBookingEvidence(manager, { bookingIds: [bookingId] }));
        await db.query("DELETE FROM public.court_reservations WHERE court_id=$1", [courtId]);
        await db.query("DELETE FROM public.courts WHERE id=$1", [courtId]);
        await db.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
        if (userId) {
          await db.query("DELETE FROM public.user_roles WHERE user_id=$1", [userId]);
          await db.query("DELETE FROM public.users WHERE id=$1", [userId]);
          expect((await auth.auth.admin.deleteUser(userId)).error).toBeNull();
        }
        expect((await request.delete(`${providerUrl}/fixture/payment`, { data: { id: paymentId } })).ok()).toBe(true);
      } finally { await db.destroy(); }
    }
  },
});

async function signIn(page: Page, booking: BookingFixture) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(booking.email);
  await page.getByLabel("Password", { exact: true }).fill(booking.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function cancelThroughBrowser(page: Page, booking: BookingFixture, message: string) {
  await page.goto("/my-activity/bookings");
  const row = page.getByRole("row", { name: /Details for/ }).filter({ hasText: booking.courtName });
  await row.click();
  await page.getByRole("dialog", { name: "Booking", exact: true }).getByRole("button", { name: "Cancel booking", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Cancel booking?", exact: true });
  await expect(confirmation).toContainText("This will cancel your booking and free the court.");
  await confirmation.getByRole("button", { name: "Cancel booking", exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
}

async function assertCancellation(booking: BookingFixture, status: string) {
  const { db, bookingId, reservationId, attemptId, paymentId, userId } = booking;
  const revisions = await db.query("SELECT id,kind,booking_state,total_amount_minor,currency,actor_user_id,cancellation_cause FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number", [bookingId]);
  expect(revisions).toHaveLength(2);
  expect(revisions[0]).toMatchObject({ kind: "created", booking_state: "confirmed", total_amount_minor: 5000 });
  expect(revisions[1]).toMatchObject({ kind: "cancelled", booking_state: "cancelled", total_amount_minor: 5000, currency: "RON", actor_user_id: userId, cancellation_cause: "owner_cancelled" });
  expect(await db.query("SELECT status,current_revision_id FROM public.bookings WHERE id=$1", [bookingId])).toEqual([{ status: "cancelled", current_revision_id: revisions[1].id }]);
  expect(await db.query("SELECT status FROM public.court_reservations WHERE id=$1", [reservationId])).toEqual([{ status: "cancelled" }]);
  expect(await db.query("SELECT id FROM public.court_reservations WHERE id=$1 AND status IN ('active','held')", [reservationId])).toEqual([]);
  const refunds = await db.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [bookingId]);
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({ payment_attempt_id: attemptId, provider_payment_id: paymentId, amount_minor: 5000, captured_amount_minor: 5000,
    currency: "RON", status, operation_key: "cancellation", reason: "booking_cancellation", context_revision_id: revisions[1].id });
  expect(await db.query("SELECT amount_minor,status,provider_payment_id FROM public.payment_attempts WHERE booking_id=$1", [bookingId])).toEqual([{ amount_minor: 5000, status: "succeeded", provider_payment_id: paymentId }]);
  return z.object({ id: z.string() }).parse(refunds[0]);
}

test("Customer cancellation releases occupancy and refunds the original payment exactly once", async ({ page, request, booking }) => {
  await signIn(page, booking);
  await cancelThroughBrowser(page, booking, "Booking cancelled. Your full payment has been refunded.");
  const refund = await assertCancellation(booking, "succeeded");
  await page.reload();
  await expect(page.getByRole("region", { name: "Upcoming", exact: true })).toContainText("No upcoming bookings");
  await page.getByRole("navigation", { name: "My activity navigation" }).getByRole("link", { name: "History", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: booking.courtName })).toContainText("Cancelled");
  await assertCancellation(booking, "succeeded");
  const executions = await booking.db.query("SELECT id,idempotency_key,status,terminal_result,amount_minor FROM public.refund_executions WHERE refund_id=$1", [refund.id]);
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({ status: "succeeded", terminal_result: "succeeded", amount_minor: 5000 });
  const evidence = evidenceSchema.parse(await (await request.get(`${providerUrl}/fixture/evidence?paymentId=${booking.paymentId}`)).json());
  expect(evidence.refunds).toEqual([expect.objectContaining({ amount: 5000, status: "succeeded", metadata: { payment_refund_id: refund.id, refund_execution_id: executions[0].id } })]);
  expect(evidence.dispatches).toEqual([{ executionId: executions[0].id, idempotencyKey: executions[0].idempotency_key }]);
});

test("Admin recovery replaces a definitively failed execution while retaining one refund obligation", async ({ page, request, booking }) => {
  // Establish failure through the real cancellation service and simulated provider response.
  await signIn(page, booking);
  await cancelThroughBrowser(page, booking, "Booking cancelled. The full refund could not be completed; please contact the club.");
  const refund = await assertCancellation(booking, "failed");
  const [before] = await booking.db.query("SELECT * FROM public.payment_refunds WHERE id=$1", [refund.id]);
  const [failed] = await booking.db.query("SELECT * FROM public.refund_executions WHERE refund_id=$1", [refund.id]);
  expect(failed).toMatchObject({ status: "failed", terminal_result: "failed", first_uncertain_at: null });
  const initial = evidenceSchema.parse(await (await request.get(`${providerUrl}/fixture/evidence?paymentId=${booking.paymentId}`)).json());
  expect(initial.refunds).toEqual([expect.objectContaining({ id: failed.provider_refund_id, status: "failed", amount: 5000 })]);
  await booking.db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [booking.userId]);
  await page.context().clearCookies();
  await signIn(page, booking);
  await page.goto(`/admin/payments/transactions?q=${booking.bookingId}`);
  const table = page.getByRole("table", { name: "Payment transactions" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await table.getByRole("link", { name: "Full refund", exact: true }).click();
  const details = page.getByRole("region", { name: "Transaction details" });
  await expect(details).toContainText(failed.id);
  await expect(details).toContainText(failed.provider_refund_id);
  await expect(details.getByText("Verified failure", { exact: true }).first()).toBeVisible();
  await details.getByRole("button", { name: "Retry refund", exact: true }).click();
  await expect(details.getByText("Verified success", { exact: true }).first()).toBeVisible();
  await expect(details.getByRole("button", { name: "Retry refund", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(details.getByRole("heading", { name: "Execution 1", exact: true })).toBeVisible();
  await expect(details.getByRole("heading", { name: "Execution 2", exact: true })).toBeVisible();
  await expect(details).toContainText(failed.id);
  await expect(details.getByText("Verified failure", { exact: true }).first()).toBeVisible();
  await expect(details.getByText("Verified success", { exact: true }).first()).toBeVisible();
  await expect(details.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(details.getByRole("region", { name: "Financial history" })).toContainText("Captured RON 50.00 · Refunded RON 50.00 · Net RON 0.00");
  await assertCancellation(booking, "succeeded");
  const [after] = await booking.db.query("SELECT * FROM public.payment_refunds WHERE id=$1", [refund.id]);
  // Only lifecycle status and timestamp may change; all obligation terms stay identical.
  expect(after).toEqual({ ...before, status: "succeeded", updated_at: after.updated_at });
  const executions = await booking.db.query("SELECT * FROM public.refund_executions WHERE refund_id=$1 ORDER BY execution_number", [refund.id]);
  expect(executions).toHaveLength(2);
  expect(executions[0]).toEqual(failed);
  expect(executions[1]).toMatchObject({ execution_number: 2, status: "succeeded", terminal_result: "succeeded", amount_minor: 5000, initiated_by_user_id: booking.userId });
  expect(executions[1].id).not.toBe(failed.id);
  expect(executions[1].idempotency_key).not.toBe(failed.idempotency_key);
  const evidence = evidenceSchema.parse(await (await request.get(`${providerUrl}/fixture/evidence?paymentId=${booking.paymentId}`)).json());
  expect(evidence.refunds).toHaveLength(2);
  expect(evidence.refunds.filter(r => r.status === "succeeded")).toEqual([expect.objectContaining({ amount: 5000,
    metadata: { payment_refund_id: refund.id, refund_execution_id: executions[1].id } })]);
  expect(evidence.dispatches).toEqual([
    { executionId: failed.id, idempotencyKey: failed.idempotency_key },
    { executionId: executions[1].id, idempotencyKey: executions[1].idempotency_key },
  ]);
  await page.getByRole("link", { name: "Back to transactions", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row", { name: new RegExp(`Full refund ${refund.id}`) })).toContainText("Completed");
});
