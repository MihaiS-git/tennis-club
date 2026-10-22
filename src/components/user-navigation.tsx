"use client";

import { Bell, CalendarDays, UserRound } from "lucide-react";
import { SidebarNavigation, type SidebarEntry } from "./sidebar-navigation";

const entries: readonly SidebarEntry[] = [
  { label: "Notifications", href: "/messages", icon: Bell },
  { label: "My activity", icon: CalendarDays, links: [
    { label: "Bookings", href: "/my-activity/bookings" },
    { label: "Booking history", href: "/my-activity/history" },
  ] },
  { label: "Profile & settings", icon: UserRound, links: [
    { label: "Player identity", href: "/profile", exact: true },
    { label: "Personal information", href: "/profile/personal" },
    { label: "Tennis profile", href: "/profile/tennis" },
    { label: "Account & security", href: "/profile/security" },
  ] },
];

export function UserNavigation() {
  return <SidebarNavigation title="My account" entries={entries} slideIn />;
}
