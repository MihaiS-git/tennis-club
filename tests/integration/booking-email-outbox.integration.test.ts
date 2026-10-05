import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";
import { localFixtureClient, cleanupAuthFixtures } from "./auth-fixtures";

// One focused persistence test: lifecycle events, failed saves, and worker claims.
test("booking mutations enqueue once atomically; worker leases isolate retries and ambiguous sends", async () => {
  const db = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID(), ruleId = randomUUID();
  const users: string[] = [], bookings: string[] = [], reservations: string[] = [];
  async function account(admin: boolean) {
    const email = `outbox-${randomUUID()}@example.test`, password = "Outbox-Local-2026!";
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const id = created.data.user!.id; users.push(id);
    if (admin) expect((await db.from("user_roles").insert({ user_id: id, role_code: "admin" })).error).toBeNull();
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    return { id, client };
  }
  try {
    const owner = await account(false), admin = await account(true);
    expect((await db.from("locations").insert({ id: locationId, name: "Outbox test", slug: `outbox-${locationId}`,
      timezone: "Europe/Bucharest", currency: "RON", is_public: true })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court 1", slug: "court-1",
      surface: "clay", environment: "outdoor", is_active: true })).error).toBeNull();
    const date = "2099-10-15";
    expect((await db.from("location_opening_hours").insert({ location_id: locationId, weekday: 3, opens_at_minute: 600, closes_at_minute: 900 })).error).toBeNull();
    expect((await db.from("pricing_rule_sets").insert({ id: ruleId, location_id: locationId })).error).toBeNull();
    expect((await db.from("location_pricing_rules").insert({ rule_set_id: ruleId, location_id: locationId, court_id: courtId,
      court_state: "outdoor", weekday: 3, starts_at_minute: 600, ends_at_minute: 900, price_per_hour_minor: 9000 })).error).toBeNull();
    for (const start of [600, 660]) {
      const created = await db.rpc("create_customer_booking", { p_court_id: courtId, p_booking_date: date,
        p_starts_at_minute: start, p_ends_at_minute: start + 60, p_account_user_id: owner.id,
        p_customer_name: "Snapshot owner", p_customer_email: "snapshot@outbox.test", p_customer_phone: "+40 123",
        p_total_amount_minor: 9000, p_currency: "RON" });
      expect(created.error).toBeNull();
      bookings.push(created.data[0].booking_id); reservations.push(created.data[0].reservation_id);
    }
    const duplicate = await db.rpc("create_customer_booking", { p_court_id: courtId, p_booking_date: date,
      p_starts_at_minute: 600, p_ends_at_minute: 660, p_account_user_id: owner.id,
      p_customer_name: "Conflict", p_customer_email: "conflict@outbox.test", p_customer_phone: "+40 123",
      p_total_amount_minor: 9000, p_currency: "RON" });
    expect(duplicate.error?.code).toBe("23P01");
    expect((await db.from("booking_email_outbox").select("id").eq("recipient", "conflict@outbox.test")).data).toEqual([]);
    for (const [i, actor, kind] of [[0, owner.client, "own"], [1, admin.client, "admin"]] as const) {
      const b = (await db.from("bookings").select("updated_at").eq("id", bookings[i]).single()).data!;
      const r = (await db.from("court_reservations").select("updated_at").eq("id", reservations[i]).single()).data!;
      const params = { p_id: bookings[i], p_expected_updated_at: r.updated_at, p_expected_booking_updated_at: b.updated_at,
        p_court_id: courtId, p_booking_date: date, p_starts_at_minute: 720 + i * 60, p_ends_at_minute: 780 + i * 60,
        p_save: true, p_expected_total: 9000, p_price_acknowledged: false };
      expect((await actor.rpc(`reschedule_${kind}_customer_booking`, { ...params, p_expected_total: 1 })).data.status).toBe("price_changed");
      expect((await actor.rpc(`reschedule_${kind}_customer_booking`, params)).data.status).toBe("updated");
      expect((await actor.rpc(`reschedule_${kind}_customer_booking`, params)).data.status).toBe("stale");
      const freshB = (await db.from("bookings").select("updated_at").eq("id", bookings[i]).single()).data!;
      const freshR = (await db.from("court_reservations").select("updated_at").eq("id", reservations[i]).single()).data!;
      expect((await actor.rpc(`reschedule_${kind}_customer_booking`, { ...params,
        p_expected_updated_at: freshR.updated_at, p_expected_booking_updated_at: freshB.updated_at })).data.status).toBe("updated");
      const cancelled = await Promise.all([actor.rpc(`cancel_${kind}_customer_booking`, { p_id: bookings[i] }),
        actor.rpc(`cancel_${kind}_customer_booking`, { p_id: bookings[i] })]);
      expect(cancelled.filter((result) => result.data === true || result.data === "cancelled")).toHaveLength(1);
    }
    const events = (await db.from("booking_email_outbox").select("*").in("booking_id", bookings)).data!;
    expect(events.map((e) => e.event_kind).sort()).toEqual(["admin_cancelled", "admin_rescheduled", "confirmed", "confirmed", "customer_cancelled", "customer_rescheduled"]);
    expect(events.every((e) => e.recipient === "snapshot@outbox.test")).toBe(true);
    expect((await owner.client.from("booking_email_outbox").select("*")).error).not.toBeNull();
    expect((await owner.client.rpc("claim_booking_email")).error).not.toBeNull();
    // Check concurrent send transitions on one fixture event without claiming unrelated local mail.
    const earliest = events.find((e) => e.event_kind === "confirmed")!;
    const token = randomUUID();
    expect((await db.from("booking_email_outbox").update({ status: "processing", lease_token: token,
      lease_until: "2099-01-01T00:00:00Z" }).eq("id", earliest.id)).error).toBeNull();
    const starts = await Promise.all([db.rpc("start_booking_email", { p_id: earliest.id, p_token: token }),
      db.rpc("start_booking_email", { p_id: earliest.id, p_token: token })]);
    expect(starts.filter((r) => r.data === true)).toHaveLength(1);
    expect((await db.rpc("finish_booking_email", { p_id: earliest.id, p_token: randomUUID(), p_outcome: "delivered" })).data).toBe(false);
    expect((await db.rpc("finish_booking_email", { p_id: earliest.id, p_token: token, p_outcome: "retry", p_error: "smtp_before_data_failed" })).data).toBe(true);
    const retried = (await db.from("booking_email_outbox").select("status,available_at").eq("id", earliest.id).single()).data!;
    expect(retried.status).toBe("pending");
    expect(new Date(retried.available_at).getTime()).toBeGreaterThan(Date.now());
    // The booking and reservation lifecycle remain committed despite delivery failure.
    expect((await db.from("bookings").select("status").in("id", bookings)).data!.every((b) => b.status === "cancelled")).toBe(true);
  } finally {
    await db.from("booking_email_outbox").delete().in("booking_id", bookings);
    await db.from("bookings").delete().in("id", bookings);
    await db.from("court_reservations").delete().in("id", reservations);
    await db.from("location_pricing_rules").delete().eq("location_id", locationId);
    await db.from("pricing_rule_sets").delete().eq("id", ruleId);
    await db.from("location_opening_hours").delete().eq("location_id", locationId);
    await db.from("courts").delete().eq("id", courtId);
    await db.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(db, users);
  }
}, 60000);
