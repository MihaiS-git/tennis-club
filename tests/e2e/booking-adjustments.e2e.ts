import { cleanupBookingEvidence, insertBookingRecords, insertCaptureReceiptFixture } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";
import { simulateStripeJs } from "./helpers/stripe";

// Stripe.js and the Stripe HTTP API are simulated; application services and PostgreSQL are real.
test("My Activity paid edit collects only the difference, X discards an unpaid modification, then partially refunds a reduction", async ({ page }) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await simulateStripeJs(page);
  const db = await new DataSource({ type:"postgres",url:process.env.DATABASE_URL }).initialize();
  const auth=createClient(process.env.SUPABASE_URL!,localServiceRoleKey(),{auth:{persistSession:false,autoRefreshToken:false}});
  const email=`adjustment-browser-${randomUUID()}@example.test`,password="Adjustment-browser-123";
  const account=await auth.auth.admin.createUser({email,password,email_confirm:true}); expect(account.error).toBeNull();
  const userId=account.data.user!.id, locationId=randomUUID(),courtId=randomUUID(),reservationId=randomUUID(),bookingId=randomUUID(),attemptId=randomUUID(),rules=randomUUID();
  const date="2099-10-15";
  try {
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Adjustment Club',$2,'UTC','RON',true)",[locationId,`adjust-${locationId}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'C2','one','clay','outdoor')",[courtId,locationId]);
    const [schedule]=await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id",[locationId]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)",[schedule.id,locationId]);
    await db.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)",[rules,locationId]);
    await db.query("INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor) VALUES($1,$2,$3,'outdoor',3,480,1200,5000)",[locationId,rules,courtId]);
    await db.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,$3,960,1020)",[reservationId,courtId,date]);
    await db.transaction(manager => insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: userId, customer_name: "Browser member", customer_email: email, customer_phone: "123", total_amount_minor: 5000, currency: "RON", payment_method: "online", status: "confirmed", cancellation_notice_minutes: 1440 }));
    const providerPaymentId = `pi_original_${attemptId}`;
    await db.transaction(async manager => {
      await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
        VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`,[attemptId,bookingId,providerPaymentId]);
      await insertCaptureReceiptFixture(manager, { paymentAttemptId: attemptId, providerPaymentId,
        providerCaptureId: providerPaymentId, amountMinor: 5000, currency: "RON" });
    });
    await page.goto('/login'); await page.getByLabel('Email',{exact:true}).fill(email); await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click(); await expect(page).toHaveURL(/\/$/);
    await page.goto('/my-activity/bookings');
    const open = async () => {
      await page.getByRole('row',{name:/Details for/}).filter({hasText:'C2'}).click();
      await page.getByRole('button',{name:'Edit booking',exact:true}).click();
    };
    await open();
    await expect(page.getByRole('button',{name:`C2 ${date} 16:00–16:30, Available, selected`,exact:true})).toHaveAttribute('aria-pressed','true');
    await page.getByRole('button',{name:`C2 ${date} 17:00–17:30, Available`,exact:true}).click();
    await expect(page.getByText(/Additional amount payable:.*25\.00/)).toBeVisible();
    await page.getByRole('checkbox').check(); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByRole('region',{name:'Booking modification'})).toBeVisible();
    const modification = page.getByRole('region',{name:'Booking modification'});
    await expect(modification.getByText('Additional amount payable',{exact:true})).toBeVisible();
    // X before paying discards the modification and releases its hold.
    await page.getByRole('button', {name:'Close dialog',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await db.query("SELECT status FROM public.booking_adjustments WHERE booking_id=$1",[bookingId]))[0].status).toBe('cancelled');
    expect(await db.query("SELECT r.status FROM public.court_reservations r JOIN public.booking_adjustments a ON a.id=r.adjustment_id WHERE a.booking_id=$1",[bookingId])).toEqual([{status:'released'}]);
    expect((await db.query("SELECT v.total_amount_minor FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1",[bookingId]))[0].total_amount_minor).toBe(5000);
    // The next Edit opens a fresh form, never the old modification or its payment.
    await page.reload(); await open();
    await expect(page.getByRole('region',{name:'Booking modification'})).toHaveCount(0);
    await page.getByRole('button',{name:`C2 ${date} 17:00–17:30, Available`,exact:true}).click();
    await expect(page.getByText(/Additional amount payable:.*25\.00/)).toBeVisible();
    await page.getByRole('checkbox').check(); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByRole('region',{name:'Booking modification'})).toBeVisible();
    await page.getByLabel('Simulated card number').fill('4242424242424242');
    await page.getByRole('button',{name:'Pay and confirm booking',exact:true}).click();
    await expect(page.getByRole('dialog', {name:'Booking',exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
    const row=page.getByRole('row',{name:/Details for/}).filter({hasText:'C2'});
    await expect(row).toContainText('16:00–17:30'); await expect(row).toContainText(/75\.00/);
    const records=await db.query("SELECT amount_minor,status FROM public.payment_attempts WHERE booking_id=$1 ORDER BY amount_minor,status",[bookingId]);
    expect(records).toEqual([{amount_minor:2500,status:'cancelled'},{amount_minor:2500,status:'succeeded'},{amount_minor:5000,status:'succeeded'}]);
    await open();
    await page.getByRole('button',{name:`C2 ${date} 17:00–17:30, Available, selected`,exact:true}).click();
    await expect(page.getByText(/Eligible refund:.*25\.00/)).toBeVisible();
    await page.getByRole('checkbox').check(); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByText('Refund completed', {exact:true})).toBeVisible();
    const resultDialog = page.getByRole('dialog');
    await expect(resultDialog.getByText('Refund amount', {exact:true})).toBeVisible();
    await expect(resultDialog.getByText('Refund status', {exact:true})).toBeVisible();
    await expect(resultDialog.getByRole('button', {name:'Close dialog',exact:true})).toBeVisible();
    expect((await db.query("SELECT amount_minor,status FROM public.payment_refunds WHERE booking_id=$1",[bookingId]))).toEqual([{amount_minor:2500,status:'succeeded'}]);
    await expect(page.getByRole('region',{name:'Booking modification'}).getByRole('button',{name:'Close',exact:true})).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
    await expect(row).toContainText('16:00–17:00'); await expect(row).toContainText(/50\.00/);
    await expect(row).toBeFocused();
    const financial = await db.query("SELECT id,amount_minor FROM public.payment_attempts WHERE booking_id=$1 AND status='succeeded' ORDER BY amount_minor DESC", [bookingId]);
    const [refund] = await db.query("SELECT f.id,e.provider_refund_id FROM public.payment_refunds f LEFT JOIN LATERAL (SELECT provider_refund_id FROM public.refund_executions WHERE refund_id=f.id ORDER BY execution_number DESC LIMIT 1) e ON true WHERE f.booking_id=$1", [bookingId]);
    const originalUrl = `/admin/payments/transactions/payment/${attemptId}`;
    // Ordinary owners cannot use Admin transaction details, including direct links.
    await page.goto(originalUrl);
    await expect(page.getByRole('heading', {name:/404|not found/i})).toBeVisible();
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [userId]);
    const listUrl = `/admin/payments/transactions?q=${bookingId}&sort=amount&dir=asc`;
    await page.goto(listUrl);
    const table = page.getByRole('table', {name:'Payment transactions'});
    await expect(table.getByRole('row')).toHaveCount(4);
    // Identify each financial row by its exact transaction link, independently of display text.
    const originalRow = table.getByRole('row').filter({has:page.locator(`a[href^="/admin/payments/transactions/payment/${attemptId}?"]`)});
    const adjustmentRow = table.getByRole('row').filter({has:page.locator(`a[href^="/admin/payments/transactions/payment/${financial[1].id}?"]`)});
    const refundRow = table.getByRole('row').filter({has:page.locator(`a[href^="/admin/payments/transactions/refund/${refund.id}?"]`)});
    await expect(originalRow).toContainText(/50\.00/);
    await expect(originalRow).toContainText('Paid');
    await expect(originalRow).not.toContainText('refunded');
    await expect(adjustmentRow).toContainText(/25\.00/);
    await expect(adjustmentRow).toContainText('Fully refunded');
    await expect(refundRow).toContainText(/25\.00/);
    await expect(refundRow).toContainText('Completed');
    await table.getByRole('link', {name:'Booking payment',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`/payment/${attemptId}\\?`));
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(attemptId);
    await expect(page.getByRole('navigation', {name:'Management navigation'}).getByRole('link', {name:'Transactions',exact:true})).toHaveAttribute('aria-current','page');
    await page.getByRole('link', {name:'Back to transactions',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`q=${bookingId}`));
    await table.getByRole('link', {name:'Price reduction refund',exact:true}).click();
    const refundUrl = `/admin/payments/transactions/refund/${refund.id}`;
    await expect(page).toHaveURL(new RegExp(refundUrl));
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(refund.provider_refund_id);
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    expect(browserErrors).toEqual([]);

  } finally {
    try {
      await db.transaction(manager => cleanupBookingEvidence(manager, { bookingIds: [bookingId] }));
      await db.query("DELETE FROM public.court_reservations WHERE court_id=$1",[courtId]);
      await db.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1",[locationId]);
      await db.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1",[locationId]);
      await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1",[locationId]);
      await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1",[locationId]);
      await db.query("DELETE FROM public.courts WHERE location_id=$1",[locationId]);
      await db.query("DELETE FROM public.locations WHERE id=$1",[locationId]);
      await db.query("DELETE FROM public.users WHERE id=$1", [userId]);
      expect((await auth.auth.admin.deleteUser(userId)).error).toBeNull();
    } finally {
      await db.destroy();
    }
  }
});
