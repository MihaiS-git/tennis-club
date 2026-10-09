import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { loadBookingEditDay, runBookingReschedule, type BookingRescheduleResult } from "./reschedule";

type Client = Awaited<ReturnType<typeof createClient>>;

async function checkOwnEditableBooking(id: unknown, client: Client) {
  z.uuid().parse(id);
  const account = await readCurrentAccount(client);
  if (account.state !== "active") return { ok: false as const, message: "An active account is required to edit a booking." };
  return { ok: true as const, account };
}

export async function getOwnBookingEditDay(id: unknown, date: unknown, supabase?: Client, now = new Date()) {
  const client = supabase ?? await createClient();
  const access = await checkOwnEditableBooking(id, client);
  if (!access.ok) throw new Error(access.message);
  return loadBookingEditDay(id, date, client, "owner", now);
}

export async function rescheduleOwnCustomerBooking(input: unknown, supabase?: Client): Promise<BookingRescheduleResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid booking." };
  const client = supabase ?? await createClient();
  try {
    const access = await checkOwnEditableBooking(parsed.data.id, client);
    if (!access.ok) return access;
    return await runBookingReschedule(input, client, access.account.userId, "owner");
  } catch {
    logger.error({ event: "bookings.self_reschedule_failed", bookingId: parsed.data.id }, "Unable to reschedule own customer booking");
    return { ok: false, message: "This booking is no longer available to reschedule. Check your account and booking notice window." };
  }
}
