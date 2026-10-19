"use client";

import { CalendarClock, CalendarDays, ClipboardList, CreditCard, GraduationCap, MapPin, Users } from "lucide-react";
import { SidebarNavigation, type SidebarEntry } from "./sidebar-navigation";

const reservations: SidebarEntry = { label: "Reservations", href: "/admin/reservations", icon: CalendarDays };
const adminEntries: readonly SidebarEntry[] = [
  { label: "Locations", href: "/admin/locations", icon: MapPin },
  reservations,
  { label: "Bookings", href: "/admin/bookings", icon: ClipboardList },
  { label: "Coaching", icon: GraduationCap, section: "/admin/coaching", links: [
    { label: "Programs", href: "/admin/coaching/programs" },
    { label: "Coaches", href: "/admin/coaching/coaches" },
    { label: "Prices", href: "/admin/coaching/prices" },
    { label: "Availability", href: "/admin/coaching/availability" },
  ] },
  { label: "Payments", icon: CreditCard, section: "/admin/payments", links: [
    { label: "Transactions", href: "/admin/payments/transactions" },
    { label: "Settings", href: "/admin/payments/settings" },
  ] },
  { label: "Users", href: "/admin/users", icon: Users },
];
const coachEntries: readonly SidebarEntry[] = [reservations];
// The Coach area is shown to every current coach, including Admins who also coach.
const ownAvailability: SidebarEntry = { label: "My availability", href: "/coach/availability", icon: CalendarClock };

export function AdminNavigation({ isAdmin, isCoach = false }: { isAdmin: boolean; isCoach?: boolean }) {
  const entries = isAdmin ? adminEntries : coachEntries;
  return <SidebarNavigation title="Management" entries={isCoach ? [...entries, ownAvailability] : entries} />;
}
