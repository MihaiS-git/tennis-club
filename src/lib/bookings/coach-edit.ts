import "server-only";

import { z } from "zod";
import { requireActiveCoach } from "@/lib/coaching/authorization";
import { localStartInstant } from "@/lib/courts/local-time";
import { inReadSnapshot } from "@/lib/db/transaction";
import { findAdminBookingDetails, findAdminBookingEditTokens } from "@/lib/db/repositories/bookings.repository";
import { readBookingEditorOptions } from "./operational-edit";
import { runOperationalBookingChange } from "./reschedule";

export async function loadCoachBookingEditor(input: unknown) {
  const actor = await requireActiveCoach();
  const id = z.uuid().parse(input);
  return inReadSnapshot(async manager => {
    const booking = await findAdminBookingDetails(manager, id, actor.userId);
    if (!booking || !booking.coaching || booking.coach_user_id !== actor.userId || booking.status !== "confirmed"
      || Date.parse(localStartInstant(booking.location_timezone, booking.booking_date, booking.starts_at_minute)) <= Date.now())
      throw new Error("This lesson is no longer available.");
    const tokens = await findAdminBookingEditTokens(manager, id);
    if (!tokens) throw new Error("This lesson is no longer available.");
    return { ...await readBookingEditorOptions(manager, booking, tokens), actingCoachId: actor.userId };
  });
}

export async function changeCoachBooking(input: unknown) {
  const actor = await requireActiveCoach();
  const result = await runOperationalBookingChange(input, actor.userId, "coach");
  if (!result.ok) return { ok: false as const, reason: result.reason, ...(result.financial ? { financial: result.financial } : {}) };
  // The UI needs the quote and settlement state, never internal refund/adjustment identities.
  return { ok: true as const, changed: result.changed, totalAmountMinor: result.totalAmountMinor, revisionId: result.revisionId,
    ...(result.financial ? { financial: result.financial } : {}),
    ...(result.adjustmentStatus ? { adjustmentStatus: result.adjustmentStatus } : {}),
    ...(result.refundStatus ? { refundStatus: result.refundStatus } : {}) };
}
