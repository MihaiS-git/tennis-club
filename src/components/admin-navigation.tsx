"use client";

import { Building2, CalendarClock, ClipboardList, CreditCard, GraduationCap, MapPin, Tag, Users } from "lucide-react";
import { SidebarNavigation, type SidebarEntry } from "./sidebar-navigation";

const adminOperations: readonly SidebarEntry[] = [
  // One Admin entry for the Calendar and List views; /admin/reservations redirects here.
  { label: "Bookings & Reservations", href: "/admin/bookings", icon: ClipboardList },
  { label: "Transactions", href: "/admin/payments/transactions", icon: CreditCard },
  { label: "Users", href: "/admin/users", icon: Users },
];
const adminConfiguration: readonly SidebarEntry[] = [
  { label: "Locations", href: "/admin/locations", icon: MapPin },
  { label: "Coaching", icon: GraduationCap, links: [
    { label: "Programs", href: "/admin/coaching/programs" },
    { label: "Coaches", href: "/admin/coaching/coaches" },
    { label: "Coach availability", href: "/admin/coaching/availability" },
  ] },
  { label: "Payment settings", href: "/admin/payments/settings", icon: CreditCard },
  { label: "Club", href: "/admin/club", icon: Building2 },
];
// Coaches get their own Calendar and List of their lessons and staff reservations.
const coachEntries: readonly SidebarEntry[] = [{ label: "Bookings & Reservations", href: "/coach/bookings", icon: ClipboardList }];
// The Coach area is shown to every current coach, including Admins who also coach.
const ownOperations: readonly SidebarEntry[] = [
  { label: "My availability", href: "/coach/availability", icon: CalendarClock },
];
const ownConfiguration: readonly SidebarEntry[] = [
  { label: "My prices", href: "/coach/pricing", icon: Tag },
];

export function AdminNavigation({ isAdmin, isCoach = false }: { isAdmin: boolean; isCoach?: boolean }) {
  return <SidebarNavigation title="Management" sections={[
    { label: "Operations", entries: [...(isAdmin ? adminOperations : coachEntries), ...(isCoach ? ownOperations : [])] },
    { label: "Configuration", entries: [...(isAdmin ? adminConfiguration : []), ...(isCoach ? ownConfiguration : [])] },
  ]} />;
}
