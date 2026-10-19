"use client";

import { useSyncExternalStore } from "react";

type Indicators = { unread: boolean; adminAlerts: boolean };
const none: Indicators = { unread: false, adminAlerts: false };
let indicators = none;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let request: AbortController | undefined;
let refreshAgain = false;

export function refreshNotificationUnread() {
  if (!listeners.size || document.visibilityState === "hidden") return;
  if (request) { refreshAgain = true; return; }
  const controller = new AbortController();
  request = controller;
  void fetch("/api/notifications/unread", { cache: "no-store", signal: controller.signal })
    .then(async response => {
      if (!response.ok) return;
      const result: unknown = await response.json();
      if (!controller.signal.aborted && typeof result === "object" && result !== null && "unread" in result && typeof result.unread === "boolean") {
        // Only an Admin response carries adminAlerts; any other shape means no Admin alert.
        const next = { unread: result.unread, adminAlerts: "adminAlerts" in result && result.adminAlerts === true };
        if (next.unread === indicators.unread && next.adminAlerts === indicators.adminAlerts) return;
        indicators = next;
        listeners.forEach(listener => listener());
      }
    }).catch(() => { /* Keep the last known state until the next refresh. */ })
    .finally(() => {
      if (request !== controller) return;
      request = undefined;
      if (refreshAgain) { refreshAgain = false; refreshNotificationUnread(); }
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      clearInterval(timer);
      if (document.visibilityState !== "hidden") {
        refreshNotificationUnread();
        timer = setInterval(refreshNotificationUnread, 60_000);
      }
    };
    window.addEventListener("focus", refreshNotificationUnread);
    document.addEventListener("visibilitychange", visibility);
    visibility();
    stop = () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshNotificationUnread);
      document.removeEventListener("visibilitychange", visibility);
      request?.abort(); request = undefined; refreshAgain = false; indicators = none;
    };
  }
  return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; } };
}
export function useNotificationUnread() {
  return useSyncExternalStore(subscribe, () => indicators, () => none);
}
