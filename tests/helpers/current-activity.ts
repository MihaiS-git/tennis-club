import type { createClient } from "@/lib/supabase/server";
import { listOwnCourtActivity } from "@/lib/bookings/activity-service";
import { parseActivityQuery } from "@/lib/bookings/activity-query";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";

// Integration assertions use the same TypeORM activity service as the application.
export async function listOwnUpcomingCustomerBookings(client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const bookings: PersonalCustomerBooking[] = [];
  for (let page = 1; ; page++) {
    const result = await listOwnCourtActivity("upcoming", parseActivityQuery({ page: String(page), type: "booking" }, "upcoming"), client, now);
    bookings.push(...result.rows.flatMap((row) => row.kind === "booking" ? [row] : []));
    if (!result.hasNext) return bookings;
  }
}
export async function listOwnCourtHistory(page: number, client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const { rows, hasNext } = await listOwnCourtActivity("history", parseActivityQuery({ page: String(page) }, "history"), client, now);
  return { rows, hasNext, page };
}

// Collect every page of the live reservation projection for mutation assertions.
export async function listOwnUpcomingReservations(client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const upcoming: import("@/lib/reservations/personal").PersonalReservation[] = [];
  for (let page = 1; ; page++) {
    const result = await listOwnCourtActivity("upcoming", parseActivityQuery({ page: String(page), type: "reservation", direction: "asc" }, "upcoming"), client, now);
    upcoming.push(...result.rows.flatMap((row) => row.kind === "reservation" ? [row] : []));
    if (!result.hasNext) return { upcoming };
  }
}
