import { cleanupBookingEvidence, insertBookingRecords } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

// Calendar and List lead to the same Booking Details, whose Back restores the origin,
// and Admin cancellation there uses the existing service without deleting records.
test("Admin opens one booking from Calendar and List, returns to each origin and cancels from details", async ({ page }) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `booking-management-${randomUUID()}@example.test`, password = "Booking-management-123";
  const account = await auth.auth.admin.createUser({ email, password, email_confirm: true }); expect(account.error).toBeNull();
  const userId = account.data.user!.id, locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
  const date = "2099-10-15", customer = `Calendar guest ${randomUUID().slice(0, 8)}`;
  try {
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [userId]);
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Management Club',$2,'UTC','RON',true)", [locationId, `manage-${locationId}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'M1','m1','clay','outdoor')", [courtId, locationId]);
    const [schedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id", [locationId]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)", [schedule.id, locationId]);
    await db.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,$3,600,660)", [reservationId, courtId, date]);
    await db.transaction(manager => insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: null,
      customer_name: customer, customer_email: "calendar-guest@example.test", customer_phone: "123", total_amount_minor: 5000,
      currency: "RON", payment_method: "pay_at_club", cancellation_notice_minutes: 1440, status: "confirmed" }));
    const [before] = await db.query("SELECT count(*)::int AS revisions FROM public.booking_revisions WHERE booking_id=$1", [bookingId]);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/$/);

    // Calendar → details → Back to Calendar, keeping location and date.
    const calendarUrl = `/admin/bookings?view=calendar&location=${locationId}&date=${date}`;
    await page.goto(calendarUrl);
    await page.getByRole("button", { name: new RegExp(`Booking · ${customer}`) }).click();
    await page.getByRole("dialog", { name: "Booking details" }).getByRole("link", { name: "View full booking details" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings/${bookingId}\\?back=`));
    await expect(page.getByRole("heading", { name: `Booking #${bookingId.slice(0, 8)}` })).toBeVisible();
    await page.getByRole("link", { name: "Back to Calendar" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings\\?view=calendar&location=${locationId}&date=${date}$`));
    await expect(page.getByLabel("Date")).toHaveValue(date);
    await page.goBack();
    await expect(page.getByRole("link", { name: "Back to Calendar" })).toBeVisible();

    // List (filters, sort) → details → Back to Bookings with the same list state.
    const listUrl = `/admin/bookings?q=${encodeURIComponent(customer)}&location=${locationId}&sort=scheduled&dir=asc`;
    await page.goto(listUrl);
    const table = page.getByRole("table", { name: "Bookings and reservations" });
    await table.getByRole("link", { name: `#${bookingId.slice(0, 8)}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings/${bookingId}\\?`));
    await page.getByRole("link", { name: "Back to Bookings" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings\\?q=.*&location=${locationId}&sort=scheduled&dir=asc$`));
    await expect(table.getByText(customer)).toBeVisible();
    await table.getByRole("link", { name: `#${bookingId.slice(0, 8)}` }).click();

    // Cancel from Booking Details through the existing Admin service.
    const actions = page.getByRole("region", { name: "Booking actions" });
    await actions.getByRole("button", { name: "Cancel booking" }).click();
    const confirmation = page.getByRole("dialog", { name: "Cancel booking?" });
    await expect(confirmation).toContainText(customer);
    await confirmation.getByRole("button", { name: "Keep booking" }).click();
    await expect(confirmation).toHaveCount(0);
    await actions.getByRole("button", { name: "Cancel booking" }).click();
    await confirmation.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.locator("[data-sonner-toast][data-type='success']")).toContainText("Booking cancelled.");
    await expect(page.getByRole("heading", { name: `Booking #${bookingId.slice(0, 8)}` }).locator("..")).toContainText("Cancelled");
    await expect(page.getByRole("button", { name: "Cancel booking" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Booking actions" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Cancel booking" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Booking history" })).toContainText("Cancelled by an administrator");

    // The booking and its history remain; only occupancy is released.
    const [after] = await db.query(`SELECT b.status, r.status AS reservation_status,
      (SELECT count(*)::int FROM public.booking_revisions WHERE booking_id=b.id) AS revisions
      FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1`, [bookingId]);
    expect(after).toEqual({ status: "cancelled", reservation_status: "cancelled", revisions: before.revisions + 1 });
    await page.goto(calendarUrl);
    await expect(page.getByRole("button", { name: new RegExp(`Booking · ${customer}`) })).toHaveCount(0);
  } finally {
    await db.transaction(manager => cleanupBookingEvidence(manager, { bookingIds: [bookingId] }));
    await db.query("DELETE FROM public.court_reservations WHERE court_id=$1", [courtId]);
    await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.courts WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
    await db.query("DELETE FROM public.user_roles WHERE user_id=$1", [userId]);
    await auth.auth.admin.deleteUser(userId); await db.destroy();
  }
});

// Editing reuses the owner rescheduling form and service: offered only for the Admin's
// own court booking, with a recalculated price that must be acknowledged before saving.
test("Admin edits their own booking from Booking Details; other customers' bookings offer no edit", async ({ page }) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `booking-edit-${randomUUID()}@example.test`, password = "Booking-edit-123";
  const account = await auth.auth.admin.createUser({ email, password, email_confirm: true }); expect(account.error).toBeNull();
  const userId = account.data.user!.id, locationId = randomUUID(), courtId = randomUUID(), rules = randomUUID();
  const ownReservation = randomUUID(), ownBooking = randomUUID(), guestReservation = randomUUID(), guestBooking = randomUUID();
  const date = "2099-10-15", owner = `Admin owner ${randomUUID().slice(0, 8)}`;
  try {
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [userId]);
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Edit Club',$2,'UTC','RON',true)", [locationId, `edit-${locationId}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'E1','e1','clay','outdoor')", [courtId, locationId]);
    const [schedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id", [locationId]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)", [schedule.id, locationId]);
    await db.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)", [rules, locationId]);
    await db.query("INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor) VALUES($1,$2,$3,'outdoor',3,480,1200,5000)", [locationId, rules, courtId]);
    await db.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,$3,600,660),($4,$2,$3,840,900)",
      [ownReservation, courtId, date, guestReservation]);
    await db.transaction(async manager => {
      await insertBookingRecords(manager, { id: ownBooking, reservation_id: ownReservation, account_user_id: userId, customer_name: owner,
        customer_email: email, customer_phone: "123", total_amount_minor: 5000, currency: "RON", payment_method: "pay_at_club",
        cancellation_notice_minutes: 1440, status: "confirmed" });
      await insertBookingRecords(manager, { id: guestBooking, reservation_id: guestReservation, account_user_id: null, customer_name: "Edit guest",
        customer_email: "edit-guest@example.test", customer_phone: "123", total_amount_minor: 5000, currency: "RON", payment_method: "pay_at_club",
        cancellation_notice_minutes: 1440, status: "confirmed" });
    });
    const evidence = `SELECT (SELECT count(*)::int FROM public.booking_revisions WHERE booking_id=$1) AS revisions,
      (SELECT count(*)::int FROM public.payment_attempts WHERE booking_id=$1) AS attempts`;
    const [before] = await db.query(evidence, [ownBooking]);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/$/);

    // Another customer's booking: cancellation only, no rescheduling.
    await page.goto(`/admin/bookings/${guestBooking}`);
    await expect(page.getByRole("region", { name: "Booking actions" }).getByRole("button", { name: "Cancel booking" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit booking" })).toHaveCount(0);

    const listUrl = `/admin/bookings?q=${encodeURIComponent(owner)}&location=${locationId}&sort=scheduled&dir=asc`;
    await page.goto(listUrl);
    await page.getByRole("table", { name: "Bookings and reservations" }).getByRole("link", { name: `#${ownBooking.slice(0, 8)}` }).click();
    await page.getByRole("region", { name: "Booking actions" }).getByRole("button", { name: "Edit booking" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit booking" });
    await dialog.getByRole("button", { name: `E1 ${date} 11:00–11:30, Available`, exact: true }).click();
    const price = dialog.getByRole("region", { name: "Booking price" });
    await expect(price).toContainText("75.00");
    // The changed total must be acknowledged before the existing service accepts it.
    await expect(dialog.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await price.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("10:00–11:30 (UTC)")).toBeVisible();
    await expect(page.getByText("75.00").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Booking history" })).toContainText("11:30");
    await page.getByRole("link", { name: "Back to Bookings" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings\\?q=.*&location=${locationId}&sort=scheduled&dir=asc$`));

    // One appended revision; no payment record is created or changed for a pay-at-club edit.
    const [after] = await db.query(evidence, [ownBooking]);
    expect(after).toEqual({ revisions: before.revisions + 1, attempts: before.attempts });
    const [row] = await db.query(`SELECT b.status, r.starts_at_minute, r.ends_at_minute, v.total_amount_minor FROM public.bookings b
      JOIN public.court_reservations r ON r.id=b.reservation_id JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1`, [ownBooking]);
    expect(row).toEqual({ status: "confirmed", starts_at_minute: 600, ends_at_minute: 690, total_amount_minor: 7500 });
  } finally {
    await db.transaction(manager => cleanupBookingEvidence(manager, { bookingIds: [ownBooking, guestBooking] }));
    await db.query("DELETE FROM public.court_reservations WHERE court_id=$1", [courtId]);
    await db.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.courts WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
    await db.query("DELETE FROM public.user_roles WHERE user_id=$1", [userId]);
    await auth.auth.admin.deleteUser(userId); await db.destroy();
  }
});

// Staff reservations are separate free records: listed in the List, opened from Calendar
// and List on their own details page, edited and cancelled through the existing Admin commands.
test("Admin manages a staff reservation from Calendar and List through its own details page", async ({ page }) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `staff-reservation-${randomUUID()}@example.test`, password = "Staff-reservation-123";
  const account = await auth.auth.admin.createUser({ email, password, email_confirm: true }); expect(account.error).toBeNull();
  const userId = account.data.user!.id, locationId = randomUUID(), courtId = randomUUID(), otherCourtId = randomUUID(), reservationId = randomUUID();
  const date = "2099-10-15", reason = `Net repair ${randomUUID().slice(0, 8)}`;
  try {
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [userId]);
    await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Staff Club',$2,'UTC','RON',true)", [locationId, `staff-${locationId}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'S1','s1','clay','outdoor'),($3,$2,'S2','s2','clay','outdoor')",
      [courtId, locationId, otherCourtId]);
    const [schedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id", [locationId]);
    await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,3,480,1200)", [schedule.id, locationId]);
    await db.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,reason,created_by_user_id)
      VALUES($1,$2,$3,600,720,$4,$5)`, [reservationId, courtId, date, reason, userId]);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/$/);

    // Calendar → reservation details → Back to Calendar, keeping location and date.
    const calendarUrl = `/admin/bookings?view=calendar&location=${locationId}&date=${date}`;
    await page.goto(calendarUrl);
    await page.getByRole("button", { name: new RegExp(`Reservation · ${email}`) }).click();
    await page.getByRole("dialog", { name: "Reservation details" }).getByRole("link", { name: "View full reservation details" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings/reservations/${reservationId}\\?back=`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: `Reservation #${reservationId.slice(0, 8)}` })).toBeVisible();
    for (const text of ["Staff Club", "S1", "10:00–12:00 (UTC)", "120 min", reason, email]) await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "Back to Calendar" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings\\?view=calendar&location=${locationId}&date=${date}$`));

    // List with the staff reservation Type → details → Back to Bookings with the same list state.
    await page.goto(`/admin/bookings?location=${locationId}&sort=scheduled&dir=asc`);
    await page.getByRole("combobox", { name: "Type" }).selectOption("reservation");
    await expect(page).toHaveURL(/type=reservation/);
    const table = page.getByRole("table", { name: "Bookings and reservations" });
    await expect(table.getByText(reason)).toBeVisible();
    await expect(table.getByText("Staff reservation")).toBeVisible();
    await table.getByRole("link", { name: `#${reservationId.slice(0, 8)}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings/reservations/${reservationId}\\?`));

    // Edit: the existing reservation form and Admin command move it to S2 14:00–15:00 with a new reason.
    const actions = page.getByRole("region", { name: "Reservation actions" });
    await actions.getByRole("button", { name: "Edit reservation" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit reservation" });
    await dialog.getByRole("button", { name: `S2 ${date} 14:00–14:30, Available` }).click();
    await dialog.getByLabel("Reason").fill(`${reason} moved`);
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("14:00–15:00 (UTC)")).toBeVisible();
    await expect(page.getByText(`${reason} moved`).first()).toBeVisible();
    const [edited] = await db.query("SELECT court_id, starts_at_minute, ends_at_minute, reason, status FROM public.court_reservations WHERE id=$1", [reservationId]);
    expect(edited).toEqual({ court_id: otherCourtId, starts_at_minute: 840, ends_at_minute: 900, reason: `${reason} moved`, status: "active" });

    // Cancel after confirmation: the record stays, shown and listed as cancelled, with no further actions.
    await actions.getByRole("button", { name: "Cancel reservation" }).click();
    const confirmation = page.getByRole("dialog", { name: "Cancel reservation?" });
    await confirmation.getByRole("button", { name: "Keep reservation" }).click();
    await expect(confirmation).toHaveCount(0);
    await actions.getByRole("button", { name: "Cancel reservation" }).click();
    await confirmation.getByRole("button", { name: "Cancel reservation" }).click();
    await expect(page.locator("[data-sonner-toast][data-type='success']", { hasText: "Reservation cancelled." })).toBeVisible();
    await expect(page.getByRole("heading", { name: `Reservation #${reservationId.slice(0, 8)}` }).locator("..")).toContainText("Cancelled");
    await expect(page.getByRole("region", { name: "Reservation actions" })).toHaveCount(0);
    const [cancelled] = await db.query("SELECT status, cancelled_by_user_id FROM public.court_reservations WHERE id=$1", [reservationId]);
    expect(cancelled).toEqual({ status: "cancelled", cancelled_by_user_id: userId });
    await page.getByRole("link", { name: "Back to Bookings" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings\\?type=reservation&location=${locationId}&sort=scheduled&dir=asc$`));
    await expect(table.getByRole("link", { name: `#${reservationId.slice(0, 8)}` })).toBeVisible();
    await expect(table.getByText("Cancelled")).toBeVisible();
    await page.getByRole("combobox", { name: "Status" }).selectOption("active");
    await expect(page.getByText("No bookings or reservations match these filters.")).toBeVisible();
    await page.goto(calendarUrl);
    await expect(page.getByRole("button", { name: new RegExp(`Reservation · ${email}`) })).toHaveCount(0);
  } finally {
    await db.query("DELETE FROM public.court_reservations WHERE court_id = ANY($1::uuid[])", [[courtId, otherCourtId]]);
    await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.courts WHERE location_id=$1", [locationId]);
    await db.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
    await db.query("DELETE FROM public.user_roles WHERE user_id=$1", [userId]);
    await auth.auth.admin.deleteUser(userId); await db.destroy();
  }
});
