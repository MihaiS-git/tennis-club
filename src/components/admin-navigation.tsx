"use client";

import { CalendarClock, ClipboardList, CreditCard, GraduationCap, MapPin, Tag, Users } from "lucide-react";
import { SidebarNavigation, type SidebarEntry } from "./sidebar-navigation";

const adminEntries: readonly SidebarEntry[] = [
  { label: "Locations", href: "/admin/locations", icon: MapPin },
  // One Admin entry for the Calendar and List views; /admin/reservations redirects here.
  { label: "Bookings & Reservations", href: "/admin/bookings", icon: ClipboardList },
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
// Coaches get their own Calendar and List of their lessons and staff reservations.
const coachEntries: readonly SidebarEntry[] = [{ label: "Bookings & Reservations", href: "/coach/bookings", icon: ClipboardList }];
// The Coach area is shown to every current coach, including Admins who also coach.
const ownEntries: readonly SidebarEntry[] = [
  { label: "My availability", href: "/coach/availability", icon: CalendarClock },
  { label: "My prices", href: "/coach/pricing", icon: Tag },
];

export function AdminNavigation({ isAdmin, isCoach = false }: { isAdmin: boolean; isCoach?: boolean }) {
  const entries = isAdmin ? adminEntries : coachEntries;
  return <SidebarNavigation title="Management" entries={isCoach ? [...entries, ...ownEntries] : entries} />;
}
