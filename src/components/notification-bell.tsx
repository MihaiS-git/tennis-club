"use client";

import { Bell } from "lucide-react";
import { ProfileDepartureLink } from "./profile-departure-navigation";
import { useNotificationUnread } from "./notification-unread";

export function NotificationBell() {
  const unread = useNotificationUnread();
  return <ProfileDepartureLink href="/my-activity/notifications" aria-label={unread ? "Notifications, unread notifications" : "Notifications"}
    className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-control border border-border-strong text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
    <Bell aria-hidden="true" className="size-5" strokeWidth={1.8} />
    {unread && <span aria-hidden="true" data-unread-indicator className="absolute right-1.5 top-1.5 size-2 rounded-full bg-green-500" />}
  </ProfileDepartureLink>;
}
