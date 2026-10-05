import "server-only";

import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { minorAmountSchema } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import type { CourtHistoryItem } from "./history";

export const HISTORY_PAGE_SIZE = 20;

const common = {
  id: z.uuid(), history_at: z.iso.datetime({ offset: true }),
  booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  location_name: z.string(), location_timezone: z.string(), court_name: z.string(),
};
export const courtHistoryRowSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("booking"), status: z.enum(["confirmed", "cancelled"]),
    customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(), cancellation_notice_minutes: cancellationNoticeMinutesSchema,
    total_amount_minor: minorAmountSchema, currency: z.enum(locationCurrencies) }),
  z.object({ ...common, kind: z.literal("reservation"), status: z.enum(["active", "cancelled"]),
    court_id: z.uuid(), location_id: z.uuid(), updated_at: z.iso.datetime({ offset: true }),
    reason: z.string().nullable(), created_by_user_id: z.uuid(), creator_name: z.string().nullable(),
    cancelled_at: z.iso.datetime({ offset: true }).nullable(), cancelled_by_name: z.string().nullable() }),
]);

export async function listOwnCourtHistory(page: number,
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") throw new Error("An active account is required.");
  const result = await supabase.rpc("list_own_court_activity_history", { p_page: page, p_now: now.toISOString() });
  const parsed = z.array(courtHistoryRowSchema).safeParse(result.data);
  if (result.error || !parsed.success || parsed.data.some((row) => row.kind === "reservation" && row.created_by_user_id !== account.userId)) {
    logger.error({ event: "activity.history_read_failed", code: result.error?.code }, "Failed to load personal court history");
    throw new Error("Unable to load your booking history.");
  }
  const rows: CourtHistoryItem[] = parsed.data.slice(0, HISTORY_PAGE_SIZE);
  return { rows, hasNext: parsed.data.length > HISTORY_PAGE_SIZE, page };
}
