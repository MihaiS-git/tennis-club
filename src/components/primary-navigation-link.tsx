"use client";

import { usePathname } from "next/navigation";
import { ProfileDepartureLink } from "./profile-departure-navigation";
import { Suspense, type ComponentProps } from "react";

function ActivePrimaryNavigationLink({ section, className = "", ...props }: ComponentProps<typeof ProfileDepartureLink> & { section?: string }) {
  const pathname = usePathname();
  const route = section ?? props.href;
  const matches = (destination: string) => pathname === destination || pathname.startsWith(`${destination}/`);
  const active = matches(route);
  return <ProfileDepartureLink {...props} aria-current={active ? "page" : undefined}
    className={`${className} ${active ? "bg-primary text-primary-foreground hover:text-primary-foreground" : "text-foreground hover:text-accent"} rounded-control px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`} />;
}

export function PrimaryNavigationLink({ section, ...props }: ComponentProps<typeof ActivePrimaryNavigationLink>) {
  return <Suspense fallback={<ProfileDepartureLink {...props} className={`${props.className ?? ""} rounded-control px-2 text-foreground hover:text-accent`} />}>
    <ActivePrimaryNavigationLink {...props} section={section} />
  </Suspense>;
}
