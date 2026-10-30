import "server-only";

import type { EntityManager } from "typeorm";
import type { findAdminBookingDetails, findAdminBookingEditTokens } from "@/lib/db/repositories/bookings.repository";
import { listAdminLocations, listAdminCourts } from "@/lib/db/repositories/clubs.repository";
import { listCoachProfiles } from "@/lib/db/repositories/coaching.repository";

// Call only after the operation has authorized this booking in the same snapshot.
export async function readBookingEditorOptions(manager: EntityManager,
  booking: NonNullable<Awaited<ReturnType<typeof findAdminBookingDetails>>>,
  tokens: NonNullable<Awaited<ReturnType<typeof findAdminBookingEditTokens>>>) {
  const locations = await listAdminLocations(manager, "current");
  const courts = await listAdminCourts(manager);
  const coaches = booking.includes_coaching ? await listCoachProfiles(manager) : [];
  return { booking: { id: booking.id, customer_name: booking.customer_name, location_name: booking.location_name,
    court_name: booking.court_name, booking_date: booking.booking_date, starts_at_minute: booking.starts_at_minute,
    ends_at_minute: booking.ends_at_minute, location_timezone: booking.location_timezone, includes_coaching: booking.includes_coaching,
    coaching: booking.coaching, coaching_program_name: booking.coaching_program_name, coach_name: booking.coach_name,
    coach_user_id: booking.coach_user_id, currency: booking.currency }, tokens, locations: locations.filter(l => l.isActive).map(l => ({ id: l.id, name: l.name,
    courts: courts.filter(c => c.locationId === l.id && c.isActive).map(c => ({ id: c.id, name: c.name })) })),
    coaches: coaches.filter(c => c.account_status === "active" && c.has_coach_role).map(c => ({ id: c.user_id, name: c.display_name })) };
}
