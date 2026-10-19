"use client";

import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ProfileDepartureLink } from "./profile-departure-navigation";
import { useNotificationUnread } from "./notification-unread";

const bellClassName = "relative inline-flex size-10 shrink-0 items-center justify-center rounded-control border border-border-strong text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary";
const dot = <span aria-hidden="true" data-unread-indicator className="absolute right-1.5 top-1.5 size-2 rounded-full bg-green-500" />;

// `admin` only chooses the layout; Admin alert data comes from the server, which
// returns it to active Admins alone.
export function NotificationBell({ admin = false }: { admin?: boolean }) {
  const { unread, adminAlerts } = useNotificationUnread();
  if (!admin) return <ProfileDepartureLink href="/my-activity/notifications" aria-label={unread ? "Notifications, unread notifications" : "Notifications"}
    className={bellClassName}>
    <Bell aria-hidden="true" className="size-5" strokeWidth={1.8} />
    {unread && dot}
  </ProfileDepartureLink>;
  return <AdminNotificationBell unread={unread} adminAlerts={adminAlerts} />;
}

function AdminNotificationBell({ unread, adminAlerts }: { unread: boolean; adminAlerts: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = ["Notifications", unread && "unread notifications", adminAlerts && "admin alerts need attention"].filter(Boolean).join(", ");

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    }
    function closeOutside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  return <div ref={root} className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(current => !current)} className={bellClassName}>
      <Bell aria-hidden="true" className="size-5" strokeWidth={1.8} />
      {(unread || adminAlerts) && dot}
    </button>
    {open && <nav id={panelId} aria-label="Notifications"
      className="absolute right-0 top-full z-40 mt-2 w-60 max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-1 shadow-card">
      <ProfileDepartureLink href="/my-activity/notifications" onClick={() => setOpen(false)}
        className="flex min-h-10 items-center justify-between gap-3 rounded-control px-3 text-sm font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
        My notifications
        {unread && <span data-personal-indicator className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <span aria-hidden="true" className="size-2 rounded-full bg-green-500" />Unread</span>}
      </ProfileDepartureLink>
      <ProfileDepartureLink href="/admin/payments/notifications" onClick={() => setOpen(false)}
        className="flex min-h-10 items-center justify-between gap-3 rounded-control px-3 text-sm font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
        Admin notifications
        {adminAlerts && <span data-admin-indicator className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <span aria-hidden="true" className="size-2 rounded-full bg-green-500" />Needs attention</span>}
      </ProfileDepartureLink>
    </nav>}
  </div>;
}
