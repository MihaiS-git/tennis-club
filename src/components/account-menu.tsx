"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { signOutAction } from "@/app/account/actions";
import { ProfileDepartureForm, ProfileDepartureLink } from "./profile-departure-navigation";
import { ProfileNavigationAvatar } from "./profile-navigation-avatar";

export function AccountMenu({ avatarUrl }: { avatarUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!open) return;
    firstLink.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return <div ref={container} className="relative" onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" aria-label="Account menu" aria-haspopup="true" aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      className="inline-flex min-h-10 items-center gap-1 rounded-control border border-border-strong px-1.5 text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
      <ProfileNavigationAvatar src={avatarUrl} desktop />
      <ChevronDown aria-hidden="true" className="size-4" />
    </button>
    <div hidden={!open} className="absolute right-0 top-full z-40 mt-2 w-52 rounded-control border border-border bg-surface p-1 shadow-floating">
      <ProfileDepartureLink ref={firstLink} href="/my-activity/bookings" onClick={() => setOpen(false)} className="block rounded-control px-3 py-2 text-sm text-primary hover:bg-surface-muted">My activity</ProfileDepartureLink>
      <ProfileDepartureLink href="/profile" onClick={() => setOpen(false)} className="block rounded-control px-3 py-2 text-sm text-primary hover:bg-surface-muted">Profile & settings</ProfileDepartureLink>
      <div className="my-1 border-t border-border" />
      <ProfileDepartureForm action={signOutAction}>
        <button type="submit" className="w-full rounded-control px-3 py-2 text-left text-sm text-primary hover:bg-surface-muted">Sign out</button>
      </ProfileDepartureForm>
    </div>
  </div>;
}
