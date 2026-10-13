import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

// Stripe.js and the Stripe HTTP API are simulated; application services and PostgreSQL are real.
test("My Activity paid edit collects only the difference, recovers after refresh, then partially refunds a reduction", async ({ page }) => {
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
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,'Adjustment Club',$2,'UTC','RON')",[locationId,`adjust-${locationId}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Adjustment Court','one','clay','outdoor')",[courtId,locationId]);
    const [schedule]=await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id",[locationId]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)",[schedule.id,locationId]);
    await db.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)",[rules,locationId]);
    await db.query("INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor) VALUES($1,$2,$3,'outdoor',3,480,1200,5000)",[locationId,rules,courtId]);
    await db.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,$3,960,1020)",[reservationId,courtId,date]);
    await db.query(`INSERT INTO public.bookings(id,reservation_id,account_user_id,customer_name,customer_email,customer_phone,total_amount_minor,currency,payment_method,status,cancellation_notice_minutes)
      VALUES($1,$2,$3,'Browser member',$4,'123',5000,'RON','online','confirmed',1440)`,[bookingId,reservationId,userId,email]);
    await db.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
      VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`,[attemptId,bookingId,`pi_original_${attemptId}`]);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto('/login'); await page.getByLabel('Email',{exact:true}).fill(email); await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click(); await expect(page).toHaveURL(/\/$/);
    await page.goto('/my-activity/bookings');
    const open = async () => {
      await page.getByRole('row',{name:/Details for/}).filter({hasText:'Adjustment Court'}).click();
      await page.getByRole('button',{name:'Edit booking',exact:true}).click();
    };
    await open();
    await page.getByRole('button',{name:`Adjustment Court ${date} 17:00–17:30, Available`,exact:true}).click();
    await expect(page.getByText(/Additional amount payable:.*25\.00/)).toBeVisible();
    await page.getByRole('checkbox').check(); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByRole('region',{name:'Booking modification'})).toBeVisible();
    expect((await db.query("SELECT total_amount_minor FROM public.bookings WHERE id=$1",[bookingId]))[0].total_amount_minor).toBe(5000);
    await page.reload(); await open();
    await page.getByLabel('Simulated card number').fill('4242424242424242');
    await page.getByRole('button',{name:'Pay and confirm booking',exact:true}).click();
    await expect(page.getByRole('dialog', {name:'Booking',exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    const row=page.getByRole('row',{name:/Details for/}).filter({hasText:'Adjustment Court'});
    await expect(row).toContainText('16:00–17:30'); await expect(row).toContainText(/75\.00/);
    const records=await db.query("SELECT amount_minor,status FROM public.payment_attempts WHERE booking_id=$1 ORDER BY amount_minor",[bookingId]);
    expect(records).toEqual([{amount_minor:2500,status:'succeeded'},{amount_minor:5000,status:'succeeded'}]);
    await open();
    await page.getByRole('button',{name:`Adjustment Court ${date} 17:00–17:30, Available, selected`,exact:true}).click();
    await expect(page.getByText(/Eligible refund:.*25\.00/)).toBeVisible();
    await page.getByRole('checkbox').check(); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByText('Refund status: Refund completed')).toBeVisible();
    expect((await db.query("SELECT amount_minor,status FROM public.payment_refunds WHERE booking_id=$1",[bookingId]))).toEqual([{amount_minor:2500,status:'succeeded'}]);
    await page.getByRole('region',{name:'Booking modification'}).getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await expect(row).toContainText('16:00–17:00'); await expect(row).toContainText(/50\.00/);
    const financial = await db.query("SELECT id,amount_minor FROM public.payment_attempts WHERE booking_id=$1 ORDER BY amount_minor DESC", [bookingId]);
    const [refund] = await db.query("SELECT id,provider_refund_id FROM public.payment_refunds WHERE booking_id=$1", [bookingId]);
    const originalUrl = `/admin/payments/transactions/payment/${attemptId}`;
    // Ordinary owners cannot use Admin transaction details, including direct links.
    await page.goto(originalUrl);
    await expect(page.getByRole('heading', {name:/404|not found/i})).toBeVisible();
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [userId]);
    const listUrl = `/admin/payments/transactions?q=${bookingId}&sort=amount&dir=asc`;
    await page.goto(listUrl);
    const table = page.getByRole('table', {name:'Payment transactions'});
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(table).toContainText(attemptId);
    await expect(table).toContainText(financial[1].id);
    await expect(table).toContainText(refund.id);
    const originalRow = table.getByRole('row', {name:new RegExp(`Original payment ${attemptId}`)});
    await expect(originalRow).toContainText(/50\.00/);
    await expect(originalRow).toContainText('Paid');
    await expect(originalRow).not.toContainText('refunded');
    await expect(table.getByRole('row', {name:/Additional adjustment payment/})).toContainText('Fully refunded');
    await expect(table.getByRole('row', {name:/Partial refund/})).toContainText('Completed');
    await page.goto(originalUrl);
    await expect(page.getByRole('region', {name:'Transaction details'})).toBeVisible();
    await page.goto(listUrl);
    await table.getByRole('link', {name:'Original payment',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`/payment/${attemptId}\\?`));
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(attemptId);
    await expect(page.getByRole('navigation', {name:'Management navigation'}).getByRole('link', {name:'Transactions',exact:true})).toHaveAttribute('aria-current','page');
    await page.reload();
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(/Net paid:.*50\.00/);
    await page.goBack(); await expect(table).toBeVisible();
    await page.goForward(); await expect(page).toHaveURL(new RegExp(`/payment/${attemptId}`));
    await page.getByRole('link', {name:'Back to transactions',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`q=${bookingId}`));
    await table.getByRole('link', {name:'Partial refund',exact:true}).click();
    const refundUrl = `/admin/payments/transactions/refund/${refund.id}`;
    await expect(page).toHaveURL(new RegExp(refundUrl));
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(refund.provider_refund_id);
    await page.goto(refundUrl); await page.reload();
    await expect(page.getByRole('region', {name:'Transaction details'})).toContainText(refund.id);
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    // Client navigation away while the booking load is in flight must dispose progress.
    await page.goto('/my-activity/bookings');
    await page.getByRole('row',{name:/Details for/}).filter({hasText:'Adjustment Court'}).click();
    await page.route('**/my-activity/bookings', async route => {
      if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 1000));
      await route.continue();
    });
    const lateLoad = page.waitForResponse(response => response.url().includes('/my-activity/bookings') && response.request().method() === 'POST');
    await page.getByRole('button',{name:'Edit booking',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'Loading booking…'})).toBeVisible();
    await page.getByRole('button',{name:'Back to details',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('navigation',{name:'My activity navigation'}).getByRole('link',{name:'History',exact:true}).click();
    await expect(page).toHaveURL(/\/my-activity\/history$/);
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    await lateLoad;
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    await page.unroute('**/my-activity/bookings');
    // A real failed Server Action request replaces progress with a visible error.
    await page.goto('/my-activity/bookings');
    await page.getByRole('row',{name:/Details for/}).filter({hasText:'Adjustment Court'}).click();
    await page.route('**/my-activity/bookings', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await page.getByRole('button',{name:'Edit booking',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('This booking is no longer available to edit.');
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
    await page.getByRole('button',{name:'Back to details',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.unroute('**/my-activity/bookings');
    expect(browserErrors).toEqual([]);

  } finally {
    await db.query("DELETE FROM public.bookings WHERE id=$1",[bookingId]);
    await db.query("DELETE FROM public.court_reservations WHERE court_id=$1",[courtId]);
    await db.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1",[locationId]);
    await db.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1",[locationId]);
    await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1",[locationId]);
    await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1",[locationId]);
    await db.query("DELETE FROM public.courts WHERE id=$1",[courtId]);
    await db.query("DELETE FROM public.locations WHERE id=$1",[locationId]);
    await auth.auth.admin.deleteUser(userId); await db.destroy();
  }
});
