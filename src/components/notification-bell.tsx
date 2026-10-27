"use client";

import { Bell } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NavbarIconAction } from "./navbar-icon-action";

export function NotificationBell({ viewport }: { viewport: "mobile" | "desktop" }) {
  const pathname = usePathname();
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(viewport === "mobile" ? "(max-width: 1023px)" : "(min-width: 1024px)");
    let current = true;
    const controller = new AbortController();
    async function refresh() {
      if (!media.matches || document.hidden) return;
      try {
        const response = await fetch("/api/messages/unread-count", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const result: unknown = await response.json();
        if (current && typeof result === "object" && result !== null && "unreadCount" in result
          && typeof result.unreadCount === "number") setUnread(result.unreadCount > 0);
      } catch { /* The next visible refresh retries transient failures. */ }
    }
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    const changed = () => { void refresh(); };
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("messages:changed", changed);
    media.addEventListener("change", changed);
    return () => {
      current = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("messages:changed", changed);
      media.removeEventListener("change", changed);
    };
  }, [pathname, viewport]);
  return <NavbarIconAction href="/messages" aria-label={unread ? "Notifications, unread messages" : "Notifications"}>
    <Bell aria-hidden="true" className="size-5" strokeWidth={1.8} />
    {unread && <span aria-hidden="true" className="absolute right-1 top-1 size-2.5 rounded-full bg-green-600 ring-2 ring-surface" />}
  </NavbarIconAction>;
}
