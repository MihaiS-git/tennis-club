"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { SegmentedNavigation, segmentedNavigationItemClass } from "./segmented-navigation";

const sections = [
  { label: "Overview", href: "/admin" },
  { label: "Locations", href: "/admin/locations" },
  { label: "Courts", href: "/admin/courts" },
  { label: "Pricing", href: "/admin/pricing" },
  { label: "Users", href: "/admin/users" },
] as const;

export function AdminNavigation() {
  const current = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const active = activeRef.current;
    if (!nav || !active) return;
    const bounds = nav.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    if (activeBounds.left < bounds.left) nav.scrollLeft += activeBounds.left - bounds.left;
    else if (activeBounds.right > bounds.right) nav.scrollLeft += activeBounds.right - bounds.right;
  }, [current]);

  return (
    <SegmentedNavigation ref={navRef} aria-label="Admin navigation" columns={5} className="mb-8">
      {sections.map(({ label, href }) => (
        <Link
          key={href}
          ref={current === href ? activeRef : undefined}
          href={href}
          aria-current={current === href ? "page" : undefined}
          className={segmentedNavigationItemClass(current === href)}
        >
          {label}
        </Link>
      ))}
    </SegmentedNavigation>
  );
}
