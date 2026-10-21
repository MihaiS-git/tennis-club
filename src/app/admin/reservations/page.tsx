import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireReservationRole } from "@/lib/reservations/authorization";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Reservations | Tennis Club" };
export const instant = false;

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<{ location?: string; date?: string }> }) {
  const account = await requireReservationRole(await createClient());
  // Admins manage the calendar inside Bookings & Reservations, and Coaches inside
  // their own Bookings & Reservations area; existing links keep their location and date.
  const { location, date } = await searchParams;
  const query = new URLSearchParams({ view: "calendar" });
  if (typeof location === "string") query.set("location", location);
  if (typeof date === "string") query.set("date", date);
  redirect(`${account.roles.includes("admin") ? "/admin/bookings" : "/coach/bookings"}?${query}`);
}
