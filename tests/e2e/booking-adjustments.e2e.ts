import { cleanupBookingEvidence, insertBookingRecords, insertCaptureReceiptFixture } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

// Stripe.js and the Stripe HTTP API are simulated; application services and PostgreSQL are real.
test("My Activity paid edit collects only the difference, X discards an unpaid modification, then partially refunds a reduction", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.route("https://js.stripe.com/**", route => route.fulfill({ contentType: "application/javascript", body: `
    window.Stripe = function() {
      return { _registerWrapper(){}, registerAppInfo(){}, createToken(){}, createPaymentMethod(){}, confirmCardPayment(){},
        elements(options) {
          const elements = { secret: options.clientSecret, update(){}, submit:async()=>({}),
            create() {
              const handlers = {};
              return { on(event,fn){handlers[event]=fn}, off(){}, update(){}, destroy(){}, unmount(){},
                mount(node) {
                  const input=document.createElement('input'); input.setAttribute('aria-label','Simulated card number'); node.appendChild(input);
                  setTimeout(()=>handlers.ready?.(),0);
                }
              };
            }, getElement(){return null} };
          return elements;
        },
        async confirmPayment({elements}) {
          const id=elements.secret.split('_secret')[0];
          const response=await fetch('http://127.0.0.1:3111/fixture/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
          return {paymentIntent:await response.json()};
        }
      };
    };` }));
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
    for (const name of ['C10', 'C3', 'C1', 'C4']) {
      const extraCourtId = randomUUID();
      await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,$3,$3,'clay','outdoor')", [extraCourtId, locationId, name]);
      await db.query("INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor) VALUES($1,$2,$3,'outdoor',3,480,1200,5000)", [locationId, rules, extraCourtId]);
    }
    await db.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,$3,960,1020)",[reservationId,courtId,date]);
    await db.transaction(manager => insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: userId, customer_name: "Browser member", customer_email: email, customer_phone: "123", total_amount_minor: 5000, currency: "RON", payment_method: "online", status: "confirmed", cancellation_notice_minutes: 1440 }));
    const providerPaymentId = `pi_original_${attemptId}`;
    await db.transaction(async manager => {
      await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
        VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`,[attemptId,bookingId,providerPaymentId]);
      await insertCaptureReceiptFixture(manager, { paymentAttemptId: attemptId, providerPaymentId,
        providerCaptureId: providerPaymentId, amountMinor: 5000, currency: "RON" });
    });
    await page.setViewportSize({width:1440,height:1000});
    await page.goto('/login'); await page.getByLabel('Email',{exact:true}).fill(email); await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click(); await expect(page).toHaveURL(/\/$/);
    await page.goto(`/book?location=${locationId}&date=${date}`);
    await expect(page.getByRole('rowheader')).toHaveText(['C1Outdoor','C2Outdoor','C3Outdoor','C4Outdoor','C10Outdoor']);
    await page.getByRole('button', {name: new RegExp(`C10 ${date} 16:00–16:30`)}).click();
    await expect(page.getByRole('region', {name:'Selected interval'})).toContainText('C10');
    await page.goto('/my-activity/bookings');
    const open = async () => {
      await page.getByRole('row',{name:/Details for/}).filter({hasText:'C2'}).click();
      await page.getByRole('button',{name:'Edit booking',exact:true}).click();
    };
    await open();
    await expect(page.getByRole('dialog').getByRole('rowheader')).toHaveText(['C1','C2','C3','C4','C10']);
    await expect(page.getByRole('button',{name:`C2 ${date} 16:00–16:30, Available, selected`,exact:true})).toHaveAttribute('aria-pressed','true');
    await page.getByRole('button',{name:`C2 ${date} 17:00–17:30, Available`,exact:true}).click();
    await expect(page.getByText(/Additional amount payable:.*25\.00/)).toBeVisible();
    await page.getByRole('checkbox').check(); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByRole('region',{name:'Booking modification'})).toBeVisible();
    const modification = page.getByRole('region',{name:'Booking modification'});
    await expect(modification.getByText('Current total',{exact:true})).toBeVisible();
    await expect(modification.getByText('Proposed total',{exact:true})).toBeVisible();
    await expect(modification.getByText('Additional amount payable',{exact:true})).toBeVisible();
    await expect(modification.locator('time')).toHaveAttribute('datetime', /T/);
    await expect(modification.getByRole('link')).toHaveCount(0);
    await expect(modification.getByRole('button',{name:'Close',exact:true})).toHaveCount(0);
    await expect(modification.getByRole('button',{name:/Cancel modification|Recover/})).toHaveCount(0);
    expect((await page.getByRole('dialog').boundingBox())!.width).toBeLessThanOrEqual(512);
    await page.screenshot({path:testInfo.outputPath('modification-payment.png'),fullPage:true});
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
    await page.setViewportSize({width:390,height:844});
    const resultDialog = page.getByRole('dialog');
    await expect(resultDialog.getByText('Refund amount', {exact:true})).toBeVisible();
    await expect(resultDialog.getByText('Refund status', {exact:true})).toBeVisible();
    await expect(resultDialog.getByRole('button', {name:'Close dialog',exact:true})).toBeVisible();
    expect(await resultDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('modification-refund-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
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
    await page.goto(`/admin/reservations?location=${locationId}&date=${date}`);
    await expect(page.getByRole('rowheader')).toHaveText(['C1','C2','C3','C4','C10']);
    await page.getByRole('button',{name:new RegExp(`C10 ${date} 16:00–16:30`)}).click();
    await expect(page.getByRole('region',{name:'Selected reservation'})).toContainText('C10');
    const listUrl = `/admin/payments/transactions?q=${bookingId}&sort=amount&dir=asc`;
    await page.goto(listUrl);
    const table = page.getByRole('table', {name:'Payment transactions'});
    await expect(table.getByRole('row')).toHaveCount(4);
    // Rows show short booking references; full transaction ids are in each row's accessible name.
    const originalRow = table.getByRole('row', {name:new RegExp(`^Booking payment ${attemptId}, booking ${bookingId}$`)});
    const adjustmentRow = table.getByRole('row', {name:new RegExp(`^Modification payment ${financial[1].id}, booking ${bookingId}$`)});
    const refundRow = table.getByRole('row', {name:new RegExp(`^Price reduction refund ${refund.id}, booking ${bookingId}$`)});
    await expect(originalRow).toContainText(/50\.00/);
    await expect(originalRow).toContainText('Paid');
    await expect(originalRow).not.toContainText('refunded');
    await expect(adjustmentRow).toContainText(/25\.00/);
    await expect(adjustmentRow).toContainText('Fully refunded');
    await expect(refundRow).toContainText(/25\.00/);
    await expect(refundRow).toContainText('Completed');
    await page.goto(originalUrl);
    await expect(page.getByRole('region', {name:'Transaction details'})).toBeVisible();
    await page.goto(listUrl);
    await table.getByRole('link', {name:'Booking payment',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`/payment/${attemptId}\\?`));
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(attemptId);
    await expect(page.getByRole('navigation', {name:'Management navigation'}).getByRole('link', {name:'Transactions',exact:true})).toHaveAttribute('aria-current','page');
    await page.reload();
    await expect(page.getByRole('region',{name:'Transaction details'})).toContainText('Paid');
    // The redesigned details show operation amounts; keep aggregate financial checks against durable evidence.
    const [totals]=await db.query(`SELECT
      (SELECT sum(c.amount_minor)::integer FROM public.payment_capture_receipts c JOIN public.payment_attempts p ON p.id=c.payment_attempt_id WHERE p.booking_id=$1) AS captured,
      (SELECT sum(amount_minor)::integer FROM public.payment_refunds WHERE booking_id=$1 AND status='succeeded') AS refunded`,[bookingId]);
    expect(totals).toEqual({captured:7500,refunded:2500});
    expect(totals.captured-totals.refunded).toBe(5000);
    // Exercise the sidebar drawer before history so hydration cannot race Back.
    const detailsViewport = page.viewportSize();
    await page.setViewportSize({ width: 768, height: 900 });
    await page.getByRole('button', {name:'Management menu',exact:true}).click();
    const managementMenu = page.getByRole('dialog', {name:'Management menu',exact:true});
    await expect(managementMenu).toBeVisible();
    await managementMenu.getByRole('button', {name:'Close management menu',exact:true}).click();
    await expect(managementMenu).toHaveCount(0);
    if (detailsViewport) await page.setViewportSize(detailsViewport);
    await page.goBack(); await expect(table).toBeVisible();
    await page.goForward(); await expect(page).toHaveURL(new RegExp(`/payment/${attemptId}`));
    await page.getByRole('link', {name:'Back to transactions',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`q=${bookingId}`));
    await table.getByRole('link', {name:'Price reduction refund',exact:true}).click();
    const refundUrl = `/admin/payments/transactions/refund/${refund.id}`;
    await expect(page).toHaveURL(new RegExp(refundUrl));
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(refund.provider_refund_id);
    await page.goto(refundUrl); await page.reload();
    await expect(page).toHaveURL(new RegExp(refundUrl));
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(refund.provider_refund_id);
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    // Client navigation away while the booking load is in flight must dispose progress.
    await page.goto('/my-activity/bookings');
    await page.getByRole('row',{name:/Details for/}).filter({hasText:'C2'}).click();
    await page.route(/\/my-activity\/bookings(?:\?.*)?$/, async route => {
      if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 1000));
      await route.continue();
    });
    const lateLoad = page.waitForResponse(response => response.url().includes('/my-activity/bookings') && response.request().method() === 'POST');
    await page.getByRole('button',{name:'Edit booking',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'Loading booking…'})).toBeVisible();
    await page.getByRole('button',{name:'Back to details',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.getByRole('navigation',{name:'My account navigation'}).getByRole('link',{name:'Booking history',exact:true}).click();
    await expect(page).toHaveURL(/\/my-activity\/history$/);
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    await lateLoad;
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    await page.unroute(/\/my-activity\/bookings(?:\?.*)?$/);
    // A real failed Server Action request replaces progress with a visible error.
    await page.goto('/my-activity/bookings');
    await page.getByRole('row',{name:/Details for/}).filter({hasText:'C2'}).click();
    await page.route(/\/my-activity\/bookings(?:\?.*)?$/, route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await page.getByRole('button',{name:'Edit booking',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('This booking is no longer available to edit.');
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    await page.getByRole('button',{name:'Back to details',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.unroute('**/my-activity/bookings');
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
