import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { courtHistoryRowSchema } from "./history-service";
import { parseActivityQuery, type ActivityQuery, type ActivityScope, type ActivitySearchParams } from "./activity-query";
import type { PersonalCustomerBooking } from "./personal";
import type { PersonalReservation } from "@/lib/reservations/personal";

export type UpcomingCourtActivity = { kind: "booking"; row: PersonalCustomerBooking } | { kind: "reservation"; row: PersonalReservation };
export type UpcomingActivity = {
  upcoming: PersonalReservation[]; bookings: PersonalCustomerBooking[];
  ordered?: UpcomingCourtActivity[];
  locations?: ActivityOptions["locations"]; courts?: ActivityOptions["courts"]; hasNext?: boolean;
};
const optionsSchema = z.object({
  locations: z.array(z.object({ id: z.uuid(), name: z.string() })),
  courts: z.array(z.object({ id: z.uuid(), name: z.string(), location_id: z.uuid() })),
});
export type ActivityOptions = z.infer<typeof optionsSchema>;
const responseSchema = optionsSchema.extend({
  rows: z.array(courtHistoryRowSchema.and(z.object({
    starts_at_instant: z.iso.datetime({ offset: true }), court_id: z.uuid(), location_id: z.uuid(),
  }))),
  hasNext: z.boolean(),
});

export async function listOwnCourtActivity(scope: ActivityScope, query: ActivityQuery,
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") throw new Error("An active account is required.");
  const result = await supabase.rpc("list_own_court_activity", {
    p_scope: scope, p_page: query.page,
    p_type: account.roles.some((role) => role === "admin" || role === "coach") ? query.type : "booking",
    p_status: query.status,
    p_location_id: query.location ?? null, p_court_id: query.court ?? null,
    p_date_from: query.from ?? null, p_date_to: query.to ?? null,
    p_sort: query.sort, p_direction: query.direction, p_now: now.toISOString(),
  });
  const parsed = responseSchema.safeParse(result.data);
  if (result.error || !parsed.success || parsed.data.rows.some((row) => row.kind === "reservation"
    && (row.created_by_user_id !== account.userId || !account.roles.some((role) => role === "admin" || role === "coach")))) {
    logger.error({ event: "activity.list_read_failed", scope, code: result.error?.code }, "Failed to load personal court activity");
    throw new Error("Unable to load your court activity. Try again.");
  }
  return parsed.data;
}

export async function listOwnUpcomingActivity(input: ActivitySearchParams = {}, client?: Awaited<ReturnType<typeof createClient>>) {
  const query = parseActivityQuery(input, "upcoming");
  const result = await listOwnCourtActivity("upcoming", query, client);
  const ordered: UpcomingCourtActivity[] = result.rows.map((row) => row.kind === "booking"
    ? { kind: "booking", row } : { kind: "reservation", row });
  return { ...result, ordered, upcoming: ordered.flatMap((item) => item.kind === "reservation" ? [item.row] : []),
    bookings: ordered.flatMap((item) => item.kind === "booking" ? [item.row] : []) };
}
