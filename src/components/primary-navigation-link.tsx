"use client";

import { usePathname } from "next/navigation";
import { NavigationLink } from "./navigation-pending";
import { Suspense, type ComponentProps } from "react";

type PrimaryLinkProps = ComponentProps<typeof NavigationLink> & { section?: string | readonly string[]; pendingPlacement?: "end" | "below" };

function ActivePrimaryNavigationLink({ section, pendingPlacement = "below", className = "", children, ...props }: PrimaryLinkProps) {
  const pathname = usePathname();
  const routes = typeof section === "string" ? [section] : section ?? [props.href];
  const matches = (destination: string) => pathname === destination || pathname.startsWith(`${destination}/`);
  const active = routes.some(matches);
  return <NavigationLink {...props} pendingPlacement={pendingPlacement} aria-current={active ? "page" : undefined}
    className={`${className} ${active ? "bg-primary text-primary-foreground hover:text-primary-foreground" : "text-foreground hover:text-accent"} relative rounded-control px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
    {children}
  </NavigationLink>;
}

export function PrimaryNavigationLink({ section, pendingPlacement = "below", children, ...props }: PrimaryLinkProps) {
  return <Suspense fallback={<NavigationLink {...props} pendingPlacement={pendingPlacement} className={`${props.className ?? ""} relative rounded-control px-2 text-foreground hover:text-accent`}>
    {children}
  </NavigationLink>}>
    <ActivePrimaryNavigationLink {...props} section={section} pendingPlacement={pendingPlacement}>{children}</ActivePrimaryNavigationLink>
  </Suspense>;
}
