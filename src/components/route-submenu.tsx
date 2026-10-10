"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { SegmentedNavigation, segmentedNavigationItemClass } from "./segmented-navigation";

export function RouteSubmenu({ sections, label }: { sections: readonly { label: string; href: string; matchDescendants?: boolean }[]; label: string }) {
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
    <SegmentedNavigation ref={navRef} aria-label={label} columns={sections.length === 2 ? 2 : sections.length === 3 ? 3 : sections.length === 4 ? 4 : sections.length === 6 ? 6 : 5} className="mb-8">
      {sections.map(({ label, href, matchDescendants }) => {
        const active = current === href || Boolean(matchDescendants && current?.startsWith(`${href}/`));
        return (
          <Link
            key={href}
            ref={active ? activeRef : undefined}
            href={href}
            aria-current={active ? "page" : undefined}
            className={segmentedNavigationItemClass(active)}
          >
            {label}
          </Link>
        );
      })}
    </SegmentedNavigation>
  );
}
