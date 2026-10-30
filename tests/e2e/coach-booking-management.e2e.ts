import { cleanupBookingEvidence, insertBookingRecords } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

// A Coach manages only their own lessons and staff reservations from the Coach Calendar
// and List; another Coach's records and the Admin routes stay unavailable.
test("Coach opens own lessons and reservations from Calendar and List, managing reservations with owner rules", async ({ page }) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const run = randomUUID().slice(0, 8), password = "Coach-bookings-123";
  const emails = [`coach-a-${run}@example.test`, `coach-b-${run}@example.test`];
  const coaches: string[] = [];
  const locationId = randomUUID(), s1 = randomUUID(), s2 = randomUUID(), program = randomUUID(), date = "2099-10-15";
  const [lessonA, lessonB, courtBooking] = [randomUUID(), randomUUID(), randomUUID()];
  const [lessonARes, lessonBRes, courtRes, ownRes, otherRes] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const studentA = `Student A ${run}`, studentB = `Student B ${run}`, courtCustomer = `Court customer ${run}`;
  const reason = `A clinic ${run}`;
  try {
    for (const email of emails) {
      const account = await auth.auth.admin.createUser({ email, password, email_confirm: true });
      expect(account.error).toBeNull();
      coaches.push(account.data.user!.id);
    }
    const [coachA, coachB] = coaches;
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach'),($2,'coach')", [coachA, coachB]);
    await db.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active)
      VALUES($1,'E2E private','','private',false,true)`, [program]);
    await db.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public)
      VALUES($1,'Coach Alpha','','','{}','{}',true),($2,'Coach Beta','','','{}','{}',true)`, [coachA, coachB]);
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Coach Club',$2,'UTC','RON',true)", [locationId, `coach-${locationId}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'S1','s1','clay','outdoor'),($3,$2,'S2','s2','clay','outdoor')",
      [s1, locationId, s2]);
    const [schedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id", [locationId]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)", [schedule.id, locationId]);
    await db.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,coach_user_id,reason,created_by_user_id) VALUES
      ($1,$6,$8,480,540,$9,NULL,NULL),($2,$7,$8,480,540,$10,NULL,NULL),($3,$6,$8,540,600,NULL,NULL,NULL),
      ($4,$6,$8,600,720,NULL,$11,$9),($5,$7,$8,600,660,NULL,'B clinic',$10)`,
      [lessonARes, lessonBRes, courtRes, ownRes, otherRes, s1, s2, date, coachA, coachB, reason]);
    const booking = (id: string, reservation: string, customer: string) => ({ id, reservation_id: reservation, account_user_id: null,
      customer_name: customer, customer_email: `${id.slice(0, 8)}@example.test`, customer_phone: "+40 711", total_amount_minor: 12000,
      currency: "RON", payment_method: "online" as const, cancellation_notice_minutes: 120, status: "confirmed" as const });
    const coaching = (coach: string, name: string) => ({ coaching: { coach_user_id: coach, coaching_program_id: program, coach_name: name,
      coaching_program_name: "E2E private" } });
    await db.transaction(manager => insertBookingRecords(manager, [{ ...booking(lessonA, lessonARes, studentA), ...coaching(coachA, "Coach Alpha") },
      { ...booking(lessonB, lessonBRes, studentB), ...coaching(coachB, "Coach Beta") }, booking(courtBooking, courtRes, courtCustomer)]));

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(emails[0]); await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/$/);

    // List: only the Coach's own lesson and reservation, without prices.
    await page.goto(`/coach/bookings?location=${locationId}&sort=scheduled&dir=asc`);
    await expect(page.getByRole("heading", { name: "Bookings & Reservations", exact: true })).toBeVisible();
    const management = page.getByRole("navigation", { name: "Management navigation" });
    await expect(management.getByRole("link", { name: "Bookings & Reservations" })).toHaveAttribute("aria-current", "page");
    const table = page.getByRole("table", { name: "Bookings and reservations" });
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table.getByText(studentA)).toBeVisible();
    await expect(table.getByText(reason)).toBeVisible();
    for (const hidden of [studentB, courtCustomer, "B clinic", "Total", "RON"]) await expect(page.getByText(hidden)).toHaveCount(0);
    await page.getByRole("combobox", { name: "Type" }).selectOption("reservation");
    await expect(page).toHaveURL(/type=reservation/);
    await expect(table.getByRole("row")).toHaveCount(2);
    await table.getByRole("link", { name: `#${ownRes.slice(0, 8)}` }).click();
    await expect(page).toHaveURL(new RegExp(`/coach/bookings/reservations/${ownRes}\\?`));
    await expect(page.getByRole("heading", { name: `Reservation #${ownRes.slice(0, 8)}` })).toBeVisible();
    await expect(page.getByRole("link", { name: "View user account" })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to Bookings" }).click();
    await expect(page).toHaveURL(new RegExp(`/coach/bookings\\?type=reservation&location=${locationId}&sort=scheduled&dir=asc$`));

    // Calendar: every court's occupancy as before; details links only on the Coach's own records.
    const calendarUrl = `/coach/bookings?view=calendar&location=${locationId}&date=${date}`;
    await page.getByRole("link", { name: "Calendar" }).click();
    await expect(page).toHaveURL(/\/coach\/bookings\?view=calendar/);
    // The server response itself carries no other customer's identity, payment or price data.
    const rendered = await (await page.request.get(calendarUrl)).text();
    expect(rendered).toContain(studentA);
    for (const leaked of [studentB, courtCustomer, `${lessonB.slice(0, 8)}@example.test`, `${courtBooking.slice(0, 8)}@example.test`, lessonB, courtBooking,
      "Coach Beta", "total_amount_minor", "stripe_refund_available", "payments", "payment_status", "account_user_id"]) expect(rendered).not.toContain(leaked);
    await page.goto(calendarUrl);
    for (const hidden of [studentB, courtCustomer]) await expect(page.getByText(hidden)).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`S1 ${date} 09:00–10:00, Booked`) })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`S2 ${date} 08:00–09:00, Booked`) }).click();
    const occupiedDialog = page.getByRole("dialog", { name: "Occupied court details" });
    await expect(occupiedDialog.getByText("08:00–09:00 (UTC)")).toBeVisible();
    await expect(occupiedDialog.getByRole("link")).toHaveCount(0);
    await expect(occupiedDialog.getByText(/Customer|Payment|Total|Coach Beta|E2E private|@/)).toHaveCount(0);
    await occupiedDialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: /Reservation · coach-b-/ }).click();
    const otherDialog = page.getByRole("dialog", { name: "Reservation details" });
    await expect(otherDialog.getByRole("link")).toHaveCount(0);
    await expect(otherDialog.getByRole("button", { name: /Edit reservation|Cancel reservation/ })).toHaveCount(0);
    await otherDialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`Your lesson · E2E private · ${studentA}`) }).click();
    const lessonDialog = page.getByRole("dialog", { name: "Lesson details" });
    for (const text of [studentA, `${lessonA.slice(0, 8)}@example.test`, "+40 711", "Coach Alpha", "E2E private"])
      await expect(lessonDialog.getByText(text, { exact: true })).toBeVisible();
    await expect(lessonDialog.getByText(/Payment|Total|RON|Currency|Customer type/)).toHaveCount(0);
    await lessonDialog.getByRole("link", { name: "View lesson details" }).click();
    await expect(page).toHaveURL(new RegExp(`/coach/bookings/lessons/${lessonA}\\?back=`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: `Lesson #${lessonA.slice(0, 8)}` })).toBeVisible();
    expect((await page.request.get(`/coach/bookings/lessons/${lessonA}`)).status()).toBe(200);
    for (const text of ["Coach Club", "S1", "08:00–09:00 (UTC)", "60 min", "E2E private", "Coach Alpha", studentA, "+40 711"])
      await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    for (const hidden of [/Payment/, /Refund/, /Total/, /RON/]) await expect(page.getByText(hidden)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel lesson", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reschedule lesson", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Back to Calendar" }).click();
    await expect(page).toHaveURL(new RegExp(`/coach/bookings\\?view=calendar&location=${locationId}&date=${date}$`));

    // Own reservation: Calendar → details → existing owner edit and cancellation.
    await page.getByRole("button", { name: /Reservation · coach-a-/ }).click();
    await page.getByRole("dialog", { name: "Reservation details" }).getByRole("link", { name: "View full reservation details" }).click();
    await expect(page).toHaveURL(new RegExp(`/coach/bookings/reservations/${ownRes}\\?back=`));
    const actions = page.getByRole("region", { name: "Reservation actions" });
    expect((await page.request.get(`/coach/bookings/reservations/${ownRes}`)).status()).toBe(200);
    await actions.getByRole("button", { name: "Edit reservation" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit reservation" });
    await dialog.getByRole("button", { name: `S2 ${date} 14:00–14:30, Available` }).click();
    await dialog.getByLabel("Reason").fill(`${reason} moved`);
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("14:00–15:00 (UTC)")).toBeVisible();
    const [edited] = await db.query("SELECT court_id, starts_at_minute, ends_at_minute, reason, status FROM public.court_reservations WHERE id=$1", [ownRes]);
    expect(edited).toEqual({ court_id: s2, starts_at_minute: 840, ends_at_minute: 900, reason: `${reason} moved`, status: "active" });
    await actions.getByRole("button", { name: "Cancel reservation" }).click();
    await page.getByRole("dialog", { name: "Cancel reservation?" }).getByRole("button", { name: "Cancel reservation" }).click();
    await expect(page.locator("[data-sonner-toast][data-type='success']", { hasText: "Reservation cancelled." })).toBeVisible();
    await expect(page.getByRole("region", { name: "Reservation actions" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: `Reservation #${ownRes.slice(0, 8)}` }).locator("..")).toContainText("Cancelled");
    const [cancelled] = await db.query("SELECT status, cancelled_by_user_id FROM public.court_reservations WHERE id=$1", [ownRes]);
    expect(cancelled).toEqual({ status: "cancelled", cancelled_by_user_id: coachA });
    await page.getByRole("link", { name: "Back to Calendar" }).click();
    await expect(page.getByRole("button", { name: /Reservation · coach-a-/ })).toHaveCount(0);

    // Invalid and unauthorized Coach details render the not-found page without protected data.
    for (const route of [`/coach/bookings/reservations/${otherRes}`, `/coach/bookings/lessons/${lessonB}`,
      `/coach/bookings/lessons/${courtBooking}`, `/coach/bookings/reservations/${lessonARes}`,
      `/coach/bookings/lessons/not-a-uuid`, `/coach/bookings/reservations/not-a-uuid`,
      `/coach/bookings/lessons/${randomUUID()}`, `/coach/bookings/reservations/${randomUUID()}`]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
      for (const hidden of [studentA, studentB, courtCustomer, reason, "B clinic", "+40 711",
        `${lessonA.slice(0, 8)}@example.test`, `${lessonB.slice(0, 8)}@example.test`, `${courtBooking.slice(0, 8)}@example.test`])
        await expect(page.getByText(hidden, { exact: true })).toHaveCount(0);
    }

    // Direct requests for another Coach's records, a court booking, or Admin routes are not found.
    for (const route of [`/coach/bookings/reservations/${otherRes}`, `/coach/bookings/lessons/${lessonB}`, `/coach/bookings/lessons/${courtBooking}`,
      `/coach/bookings/reservations/${lessonARes}`, `/admin/bookings/${lessonA}`, `/admin/bookings/reservations/${ownRes}`,
      `/admin/bookings?location=${locationId}`]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
      await expect(page.getByText(studentB)).toHaveCount(0);
    }
    const [untouched] = await db.query("SELECT status FROM public.court_reservations WHERE id=$1", [otherRes]);
    expect(untouched).toEqual({ status: "active" });
  } finally {
    try {
      await db.transaction(manager => cleanupBookingEvidence(manager, { bookingIds: [lessonA, lessonB, courtBooking] }));
      await db.query("DELETE FROM public.court_reservations WHERE court_id = ANY($1::uuid[])", [[s1, s2]]);
      await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
      await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1", [locationId]);
      await db.query("DELETE FROM public.courts WHERE location_id=$1", [locationId]);
      await db.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
      await db.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [coaches]);
      await db.query("DELETE FROM public.coaching_programs WHERE id=$1", [program]);
      await db.query("DELETE FROM public.user_roles WHERE user_id = ANY($1::uuid[])", [coaches]);
      for (const id of coaches) {
        await db.query("DELETE FROM public.users WHERE id=$1", [id]);
        expect((await auth.auth.admin.deleteUser(id)).error).toBeNull();
      }
    } finally {
      await db.destroy();
    }
  }
});


test("Coach reschedules from List, reassigns from Calendar and replacement Coach edits and cancels from Details", async ({ page }) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const run = randomUUID().slice(0, 8), password = "Coach-bookings-123";
  const emails = [`coach-a-${run}@example.test`, `coach-b-${run}@example.test`];
  const coaches: string[] = [];
  const locationId = randomUUID(), s1 = randomUUID(), s2 = randomUUID(), program = randomUUID(), date = "2099-10-15";
  const [lessonA, lessonB, courtBooking] = [randomUUID(), randomUUID(), randomUUID()];
  const [lessonARes, lessonBRes, courtRes, ownRes, otherRes] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const studentA = `Student A ${run}`, studentB = `Student B ${run}`, courtCustomer = `Court customer ${run}`;
  const reason = `A clinic ${run}`;
  const destinationLocation = randomUUID(), destinationCourt = randomUUID();
  try {
    for (const email of emails) {
      const account = await auth.auth.admin.createUser({ email, password, email_confirm: true });
      expect(account.error).toBeNull();
      coaches.push(account.data.user!.id);
    }
    const [coachA, coachB] = coaches;
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach'),($2,'coach')", [coachA, coachB]);
    await db.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active)
      VALUES($1,'E2E private','','private',false,true)`, [program]);
    await db.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public)
      VALUES($1,'Coach Alpha','','','{}','{}',true),($2,'Coach Beta','','','{}','{}',true)`, [coachA, coachB]);
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Coach Club',$2,'UTC','RON',true)", [locationId, `coach-${locationId}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'S1','s1','clay','outdoor'),($3,$2,'S2','s2','clay','outdoor')",
      [s1, locationId, s2]);
    const [schedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id", [locationId]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)", [schedule.id, locationId]);
    await db.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,coach_user_id,reason,created_by_user_id) VALUES
      ($1,$6,$8,480,540,$9,NULL,NULL),($2,$7,$8,480,540,$10,NULL,NULL),($3,$6,$8,540,600,NULL,NULL,NULL),
      ($4,$6,$8,600,720,NULL,$11,$9),($5,$7,$8,600,660,NULL,'B clinic',$10)`,
      [lessonARes, lessonBRes, courtRes, ownRes, otherRes, s1, s2, date, coachA, coachB, reason]);
    const booking = (id: string, reservation: string, customer: string) => ({ id, reservation_id: reservation, account_user_id: null,
      customer_name: customer, customer_email: `${id.slice(0, 8)}@example.test`, customer_phone: "+40 711", total_amount_minor: 12000,
      currency: "RON", payment_method: "online" as const, cancellation_notice_minutes: 120, status: "confirmed" as const });
    const coaching = (coach: string, name: string) => ({ coaching: { coach_user_id: coach, coaching_program_id: program, coach_name: name,
      coaching_program_name: "E2E private" }, pricing_evidence: {
        version: 1, rounding: "half-hour-sum-round", courtState: "outdoor", slots: [480, 510].map(minute => ({ minute, ruleId: randomUUID(), ruleSetId: randomUUID(),
          hourlyMinor: 5000, startsOn: null, endsOn: null })),
        coaching: { participantCount: 1, pricePerPersonMinor: 12000, programId: program, coachUserId: coach,
          locationId, durationMinutes: 60, source: "club", amountMinor: 12000, currency: "RON",
          courtRentalIncluded: true, courtRentalMinor: 5000, courtAmountMinor: 0 } } });
    await db.transaction(manager => insertBookingRecords(manager, [{ ...booking(lessonA, lessonARes, studentA), ...coaching(coachA, "Coach Alpha") },
      { ...booking(lessonB, lessonBRes, studentB), ...coaching(coachB, "Coach Beta") }, booking(courtBooking, courtRes, courtCustomer)]));

    const [ruleSet] = await db.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [locationId]);
    await db.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      SELECT $1,$2,c,'outdoor',3,480,1200,5000 FROM unnest($3::uuid[]) c`, [locationId, ruleSet.id, [s1, s2]]);
    await db.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [coachB, locationId]);
    await db.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
      VALUES($1,$2,3,480,1080,'2000-01-01')`, [coachB, locationId]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    async function login(email: string) {
      await page.context().clearCookies();
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(/\/$/);
    }
    async function confirmChange() {
      const editor = page.getByRole("region", { name: "Rescheduling booking", exact: true });
      await editor.getByRole("button", { name: "Preview change" }).click();
      await expect(editor.getByRole("region", { name: "Financial preview" })).toContainText("Final customer obligation");
      await expect(editor.getByRole("region", { name: "Financial preview" })).toContainText("RON");
      await editor.getByRole("button", { name: "Confirm booking change" }).click();
      await expect(editor).toHaveCount(0);
    }
    await login(emails[0]);
    // Even a dual-role account must use Coach permissions inside the Coach area.
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [coachA]);
    await page.goto(`/coach/bookings/lessons/${lessonB}`);
    await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
    // List edits use the shared form. Acting Coach A has no hours or locations: self override applies.
    await page.goto(`/coach/bookings?q=${encodeURIComponent(studentA)}`);
    await page.getByRole("table").getByRole("button", { name: "Reschedule lesson" }).click();
    let editor = page.getByRole("region", { name: "Rescheduling booking", exact: true });
    await expect(page).toHaveURL(new RegExp(`view=calendar&reschedule=${lessonA}`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Court timetable" })).toHaveCount(1);
    await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /S2 .*13:00–14:00/ }).click();
    await confirmChange();
    await page.goto(`/coach/bookings?q=${encodeURIComponent(studentA)}`);
    await expect(page.getByRole("table")).toContainText("13:00–14:00");
    // Calendar opens the same editor and permits reassignment to a Coach without the program.
    await page.goto(`/coach/bookings?view=calendar&location=${locationId}&date=${date}`);
    const mountedTimetable = page.getByRole("table", { name: "Court timetable" });
    await mountedTimetable.evaluate(node => node.setAttribute("data-mounted-calendar", "coach"));
    await page.getByRole("button", { name: new RegExp(`Your lesson · E2E private · ${studentA}`) }).click();
    await page.getByRole("dialog", { name: "Lesson details", exact: true }).getByRole("button", { name: "Reschedule lesson" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(mountedTimetable).toHaveAttribute("data-mounted-calendar", "coach");
    editor = page.getByRole("region", { name: "Rescheduling booking", exact: true });
    await editor.getByLabel("Assigned Coach").selectOption(coachB);
    // Coach B has no availability after 18:00. Admin status must not override it here.
    await expect(page.getByRole("table", { name: "Court timetable" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /18:30–19:30/ })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Confirm booking change" })).toHaveCount(0);
    expect(await db.query("SELECT coach_user_id,starts_at_minute FROM public.court_reservations WHERE id=$1", [lessonARes]))
      .toEqual([{ coach_user_id: coachA, starts_at_minute: 780 }]);
    // Coach-only reassignment retains the original court and interval without a slot click.
    await confirmChange();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`Your lesson · E2E private · ${studentA}`) })).toHaveCount(0);
    const notices = await db.query("SELECT id,user_id,kind,body_text FROM public.user_messages WHERE user_id=ANY($1::uuid[]) AND kind IN ('coaching.assigned','coaching.unassigned') ORDER BY kind", [coaches]);
    expect(notices).toEqual([
      expect.objectContaining({ user_id: coachB, kind: "coaching.assigned" }),
      expect.objectContaining({ user_id: coachA, kind: "coaching.unassigned" }),
    ]);
    for (const notice of notices) expect(notice.body_text).not.toMatch(/RON|refund|price|paid|obligation|absorbed/i);
    await page.goto(`/messages/${notices[1].id}`);
    await expect(page.getByText(notices[1].body_text, { exact: true })).toBeVisible();
    await page.goto(`/coach/bookings/lessons/${lessonA}`);
    await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
    await login(emails[1]);
    await page.goto(`/messages/${notices[0].id}`);
    await expect(page.getByText(notices[0].body_text, { exact: true })).toBeVisible();
    // Replacement Coach gains details, editing and cancellation permissions immediately.
    await page.goto(`/coach/bookings/lessons/${lessonA}`);
    await page.getByRole("button", { name: "Reschedule lesson", exact: true }).click();
    editor = page.getByRole("region", { name: "Rescheduling booking", exact: true });
    await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /S2 .*14:00–15:00/ }).click();
    await confirmChange();
    await page.goto(`/coach/bookings/lessons/${lessonA}`);
    await expect(page.getByText("14:00–15:00 (UTC)")).toBeVisible();
    const [assigned] = await db.query(`SELECT r.coach_user_id,r.court_id,r.starts_at_minute,v.total_amount_minor,v.actor_scope
      FROM public.court_reservations r JOIN public.checkout_records b ON b.reservation_id=r.id
      JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1`, [lessonA]);
    expect(assigned).toEqual({ coach_user_id: coachB, court_id: s2, starts_at_minute: 840, total_amount_minor: 12000, actor_scope: "coach" });
    // A Coach may move their own lesson across locations/dates using the same editor.
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,'Destination Coach Club',$2,'UTC','RON')", [destinationLocation, `coach-destination-${run}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'D1','d1','clay','outdoor')", [destinationCourt, destinationLocation]);
    const [destinationSchedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id", [destinationLocation]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)", [destinationSchedule.id, destinationLocation]);
    const [destinationRules] = await db.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [destinationLocation]);
    await db.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      VALUES($1,$2,$3,'outdoor',3,480,1200,15000)`, [destinationLocation, destinationRules.id, destinationCourt]);
    await page.getByRole("button", { name: "Reschedule lesson", exact: true }).click();
    editor = page.getByRole("region", { name: "Rescheduling booking", exact: true });
    await page.getByLabel("Location", { exact: true }).selectOption(destinationLocation);
    await page.getByLabel("Date", { exact: true }).fill("2099-10-22");
    await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /D1 .*16:00–17:00/ }).click();
    await confirmChange();
    await page.goto(`/coach/bookings/lessons/${lessonA}`);
    await expect(page.getByText("16:00–17:00 (UTC)")).toBeVisible();
    expect(await db.query(`SELECT r.court_id,r.booking_date::text,v.total_amount_minor FROM public.court_reservations r
      JOIN public.checkout_records b ON b.reservation_id=r.id JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1`, [lessonA]))
      .toEqual([{ court_id: destinationCourt, booking_date: "2099-10-22", total_amount_minor: 12000 }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Cancel lesson", exact: true }).click();
    const cancellation = page.getByRole("dialog", { name: "Cancel lesson?", exact: true });
    await expect(cancellation).toContainText("Coach:");
    await expect(cancellation.getByRole("button", { name: "Keep booking" })).toBeFocused();
    await page.keyboard.press("Escape");
    expect(await db.query("SELECT status FROM public.checkout_records WHERE id=$1", [lessonA])).toEqual([{ status: "confirmed" }]);
    await page.getByRole("button", { name: "Cancel lesson", exact: true }).click();
    await expect(cancellation.getByLabel("Cancellation explanation (optional)")).toHaveCount(0);
    await cancellation.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
    await expect(page.getByRole("region", { name: "Lesson actions" })).toHaveCount(0);
    const [cancelled] = await db.query("SELECT status,cancelled_by_user_id FROM public.court_reservations WHERE id=$1", [lessonARes]);
    expect(cancelled).toEqual({ status: "cancelled", cancelled_by_user_id: coachB });

    // The same dual-role actor uses Admin authority explicitly in the Admin area.
    await login(emails[0]);
    await page.goto(`/admin/bookings/${lessonB}`);
    await page.getByRole("button", { name: "Edit booking", exact: true }).click();
    const adminEditor = page.getByRole("region", { name: "Rescheduling booking", exact: true });
    await adminEditor.getByLabel("Assigned Coach").selectOption(coachA);
    await page.getByLabel("Date", { exact: true }).fill("2099-10-22");
    await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /S1 .*15:00–16:00/ }).click();
    await adminEditor.getByRole("button", { name: "Preview change" }).click();
    await expect(adminEditor.getByRole("region", { name: "Financial preview" })).toContainText("No financial adjustment.");
    await adminEditor.getByRole("button", { name: "Confirm booking change" }).click();
    await expect(adminEditor).toHaveCount(0);
    await page.goto(`/admin/bookings/${lessonB}`);
    await expect(page.getByText("15:00–16:00 (UTC)")).toBeVisible();
    expect(await db.query(`SELECT r.coach_user_id,r.court_id,r.booking_date::text,v.total_amount_minor,v.actor_scope
      FROM public.court_reservations r JOIN public.checkout_records b ON b.reservation_id=r.id
      JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1`, [lessonB]))
      .toEqual([{ coach_user_id: coachA, court_id: s1, booking_date: "2099-10-22", total_amount_minor: 12000, actor_scope: "admin" }]);
    await page.getByRole("button", { name: "Cancel booking", exact: true }).click();
    const adminCancellation = page.getByRole("dialog", { name: "Cancel booking?", exact: true });
    await adminCancellation.getByLabel("Cancellation explanation (optional)").fill("Coach illness");
    await adminCancellation.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
    await expect(page.getByRole("region", { name: "Booking actions" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Booking history" })).toContainText("Coach illness");
    await page.reload();
    await expect(page.getByRole("region", { name: "Booking history" })).toContainText("Coach illness");
  } finally {
    try {
      await db.transaction(manager => cleanupBookingEvidence(manager, { bookingIds: [lessonA, lessonB, courtBooking] }));
      await db.query("DELETE FROM public.court_reservations WHERE court_id = ANY($1::uuid[])", [[s1, s2, destinationCourt]]);
      await db.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
      await db.query("DELETE FROM public.coach_locations WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
      for (const location of [locationId, destinationLocation]) {
        await db.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [location]);
        await db.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1", [location]);
        await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [location]);
        await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1", [location]);
        await db.query("DELETE FROM public.courts WHERE location_id=$1", [location]);
        await db.query("DELETE FROM public.locations WHERE id=$1", [location]);
      }
      await db.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [coaches]);
      await db.query("DELETE FROM public.coaching_programs WHERE id=$1", [program]);
      await db.query("DELETE FROM public.user_roles WHERE user_id = ANY($1::uuid[])", [coaches]);
      for (const id of coaches) {
        await db.query("DELETE FROM public.users WHERE id=$1", [id]);
        expect((await auth.auth.admin.deleteUser(id)).error).toBeNull();
      }
    } finally {
      await db.destroy();
    }
  }
});
