import "server-only";

import { z } from "zod";
import { localStartInstant } from "@/lib/courts/local-time";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { inReadSnapshot } from "@/lib/db/transaction";
import { findAdminBookingDetails, findAdminBookingEditTokens } from "@/lib/db/repositories/bookings.repository";
import { readBookingEditorOptions } from "./operational-edit";
import { runOperationalBookingChange } from "./reschedule";

export async function loadAdminBookingEditor(input: unknown) {
  await requireActiveAdmin();
  const id = z.uuid().parse(input);
  return inReadSnapshot(async manager => {
    const booking = await findAdminBookingDetails(manager, id);
    const tokens = await findAdminBookingEditTokens(manager, id);
    if (!booking || !tokens || booking.status !== "confirmed"
      || Date.parse(localStartInstant(booking.location_timezone, booking.booking_date, booking.starts_at_minute)) <= Date.now()) throw new Error("This booking is no longer available.");
    return readBookingEditorOptions(manager, booking, tokens);
  });
}
export type AdminBookingEditor = Awaited<ReturnType<typeof loadAdminBookingEditor>>;

export async function changeAdminBooking(input: unknown) {
  const actor = await requireActiveAdmin();
  return runOperationalBookingChange(input, actor.userId, "admin");
}

