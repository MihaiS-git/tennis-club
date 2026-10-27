"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { useTransition, type ComponentProps } from "react";
import { ProfileDepartureLink } from "./profile-departure-navigation";
import { Spinner } from "./spinner";

// One announcement for a filter transition; the results and controls remain visible.
export function FilterPendingIndicator({ pending }: { pending: boolean }) {
  return <span role={pending ? "status" : undefined} aria-atomic="true"
    className="pointer-events-none absolute right-0 top-full inline-flex h-4 items-center text-primary">
    {pending && <><Spinner size="small" /><span className="sr-only">Updating results…</span></>}
  </span>;
}

function LinkPendingIndicator() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={`pointer-events-none absolute inset-0 flex items-center justify-center rounded-control ${pending ? "bg-surface/95 text-primary" : "invisible"}`}>
    {pending && <Spinner size="small" />}
  </span>;
}

// Compact result navigation (sort, pagination, tabs). Owns overlay positioning.
export function PendingLink({ children, className, ...props }: ComponentProps<typeof Link>) {
  return <Link {...props} className={`relative ${className ?? ""}`}>
    {children}<LinkPendingIndicator />
  </Link>;
}

type Placement = "end" | "below" | "after";

function LinkPendingSpinner({ placement = "end", size = "small", pending: navigationPending }: {
  placement?: Placement; size?: "small" | "compact"; pending?: boolean;
}) {
  const { pending: linkPending } = useLinkStatus();
  const pending = navigationPending ?? linkPending;
  return <span aria-hidden="true" className={`pointer-events-none inline-flex ${size === "compact" ? "size-2.5" : "size-3.5"} shrink-0 items-center justify-center ${placement === "end" ? "ml-auto" : placement === "below" ? `absolute left-1/2 top-full ${size === "compact" ? "mt-0" : "mt-px"} -translate-x-1/2 text-primary` : "absolute left-full top-1/2 ml-1.5 -translate-y-1/2 text-primary"}`}>
    {pending && <Spinner size={size} />}
  </span>;
}

// A drawer dismissal is part of the navigation transition, so it commits even when
// a redirect returns to the current pathname. The urgent pending render keeps the
// selected link visible until then. Desktop links retain Next's normal navigation.
export function NavigationLink({ children, className = "", dismissDrawer, pendingPlacement = "end", pendingSize = "small", ...props }:
  Omit<ComponentProps<typeof ProfileDepartureLink>, "onNavigate"> & {
    dismissDrawer?: () => void; pendingPlacement?: Placement; pendingSize?: "small" | "compact";
  }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <ProfileDepartureLink {...props} className={`${pendingPlacement === "after" ? "" : "relative"} ${className}`}
    onNavigate={event => {
      if (!dismissDrawer) return;
      event.preventDefault();
      startTransition(() => {
        dismissDrawer();
        router.push(props.href);
      });
    }}>
    {pendingPlacement === "after" ? <span className="relative">{children}<LinkPendingSpinner placement="after" /></span>
      : <>{children}<LinkPendingSpinner placement={pendingPlacement} size={pendingSize} pending={dismissDrawer ? pending : undefined} /></>}
  </ProfileDepartureLink>;
}
