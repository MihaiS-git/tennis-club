import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assert } from "vitest";

/** Explicit baseline for legacy weekly fixtures; production never infers a schedule. */
export async function insertOpeningHoursFixture(service: SupabaseClient, input: unknown) {
  const rows = z.array(z.object({ location_id: z.uuid(), schedule_id: z.uuid().optional() }).passthrough())
    .parse(Array.isArray(input) ? input : [input]);
  for (const locationId of new Set(rows.filter((r) => !r.schedule_id).map((r) => r.location_id))) {
    const existing = await service.from("opening_hours_schedules").select("id").eq("location_id", locationId);
    assert.strictEqual(existing.error, null);
    assert.ok(existing.data);
    if (existing.data.length > 1) throw new Error("Opening-hours fixture requires an explicit schedule_id when multiple schedules exist.");
    let scheduleId = existing.data[0]?.id;
    if (!scheduleId) {
      const created = await service.from("opening_hours_schedules")
        .insert({ location_id: locationId, starts_on: "0001-01-01" }).select("id").single();
      assert.strictEqual(created.error, null); assert.ok(created.data);
      scheduleId = created.data.id;
    }
    for (const row of rows.filter((r) => r.location_id === locationId && !r.schedule_id)) row.schedule_id = scheduleId;
  }
  return service.from("location_opening_hours").insert(rows);
}

export async function configureCheckoutPolicyFixture(service: SupabaseClient, locationId: string, courtId: string) {
  assert.strictEqual((await insertOpeningHoursFixture(service, Array.from({ length: 7 },(_,weekday) => ({
    location_id: locationId,weekday,opens_at_minute: 0,closes_at_minute: 1440,
  })))).error,null);
  const parent = await service.from("pricing_rule_sets").insert({ location_id: locationId }).select("id").single();
  assert.strictEqual(parent.error,null); assert.ok(parent.data);
  assert.strictEqual((await service.from("location_pricing_rules").insert(Array.from({ length: 7 },(_,weekday) => ({
    location_id: locationId,rule_set_id: parent.data!.id,court_id: courtId,court_state: "outdoor",weekday,
    starts_at_minute: 0,ends_at_minute: 1440,price_per_hour_minor: 5000,
  })))).error,null);
}
