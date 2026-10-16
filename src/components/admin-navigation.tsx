"use client";

import { CalendarDays, CreditCard, MapPin, Users } from "lucide-react";
import { SidebarNavigation, type SidebarEntry } from "./sidebar-navigation";

const reservations: SidebarEntry = { label: "Reservations", href: "/admin/reservations", icon: CalendarDays };
const adminEntries: readonly SidebarEntry[] = [
  { label: "Locations", href: "/admin/locations", icon: MapPin },
  reservations,
  { label: "Payments", icon: CreditCard, section: "/admin/payments", links: [
    { label: "Transactions", href: "/admin/payments/transactions" },
    { label: "Notifications", href: "/admin/payments/notifications" },
    { label: "Settings", href: "/admin/payments/settings" },
  ] },
  { label: "Users", href: "/admin/users", icon: Users },
];
const coachEntries: readonly SidebarEntry[] = [reservations];

export function AdminNavigation({ isAdmin }: { isAdmin: boolean }) {
  return <SidebarNavigation title="Management" entries={isAdmin ? adminEntries : coachEntries} />;
}
