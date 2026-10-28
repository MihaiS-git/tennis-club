"use client";

import { SignOutButton } from "./sign-out-button";

import { Menu, X } from "lucide-react";
import { Button } from "@/components/button";
import { signOutAction } from "@/app/account/actions";
import { ProfileDepartureForm } from "./profile-departure-navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavigationLink as Link } from "./navigation-pending";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { PrimaryNavigationLink } from "./primary-navigation-link";
import { BookCourtLink } from "./book-court-link";
import { ProfileNavigationAvatar } from "./profile-navigation-avatar";
import { NotificationBell } from "./notification-bell";

export function MobileNavbarShell({ children }: { children: ReactNode }) {
  return <header className="sticky top-0 z-30 w-full border-b border-border bg-surface lg:hidden">
    <div className="flex h-16 items-center justify-between gap-2 px-4">
      <Link pendingPlacement="below" href="/" prefetch={false} className="relative font-heading text-base font-semibold tracking-tight text-primary hover:text-accent sm:text-lg">
        Tennis Club
      </Link>
      <div className="flex items-center gap-2">
        <BookCourtLink pendingSize="compact" className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-control bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-primary-hover sm:text-sm" />
        {children}
      </div>
    </div>
  </header>;
}

export function MobileNavbarMenu(props: Parameters<typeof MobileNavbarControls>[0]) {
  return <MobileNavbarShell><MobileNavbarControls {...props} /></MobileNavbarShell>;
}

export function MobileNavbarControls({ isAuthenticated, hasMessageAccess = false, canReserve, avatarUrl = null }: {
  isAuthenticated: boolean; hasMessageAccess?: boolean; canReserve: boolean; avatarUrl?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The closed drawer sits just off-screen, inside Link's viewport margin, so its hidden
  // links would prefetch on every page. Prefetch account pages once opened;
  // public photo pages stay off because their resource hints also fetch heroes.
  const drawerPrefetch = isOpen ? undefined : false;

  function closeMenu() {
    setIsOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  // A dismissal that commits with a navigation (or history/viewport change) hides the
  // drawer while its link may still have focus. Move focus out in that same commit,
  // before the browser observes focus inside the aria-hidden, inert drawer. This runs
  // in the layout phase: React reverts focus changes made during DOM mutation.
  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    if (isOpen || !drawer?.contains(document.activeElement)) return;
    triggerRef.current?.focus({ preventScroll: true });
    // At desktop width the whole mobile header is hidden and the trigger cannot take focus.
    if (drawer.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const [drawer, trigger] = [drawerRef.current, triggerRef.current];

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }

    const closeOnHistory = () => setIsOpen(false);
    window.addEventListener("popstate", closeOnHistory);
    const desktopViewport = window.matchMedia?.("(min-width: 1024px)");
    function closeOnDesktop(event: MediaQueryListEvent) {
      if (event.matches) setIsOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    desktopViewport?.addEventListener("change", closeOnDesktop);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("popstate", closeOnHistory);
      desktopViewport?.removeEventListener("change", closeOnDesktop);
      document.body.style.overflow = previousOverflow;
      // Return focus only if navigation has not already moved it outside the drawer.
      if (drawer?.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  function keepFocusInDrawer(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;

    const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <>
      {hasMessageAccess && <NotificationBell viewport="mobile" />}
          <Button
            ref={triggerRef}
            type="button"
            aria-label={isOpen ? "Close menu" : "Open menu"}
            aria-controls={menuId}
            aria-expanded={isOpen}
            onClick={() => isOpen ? closeMenu() : setIsOpen(true)}
            variant="secondary"
            size="iconLarge"
          >
            <Menu aria-hidden="true" className="size-5" strokeWidth={1.8} />
          </Button>

      {isOpen && (
        <button
          type="button"
          aria-label="Close menu backdrop"
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeMenu}
          className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px]"
        />
      )}

      <section
        ref={drawerRef}
        id={menuId}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation menu"
        aria-hidden={!isOpen}
        inert={!isOpen}
        onKeyDown={keepFocusInDrawer}
        className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-[90vw] max-w-[360px] flex-col border-r border-border bg-surface transition-transform duration-[var(--ui-duration-base)] ease-standard motion-reduce:transition-none ${isOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="font-heading text-base font-semibold tracking-tight text-primary sm:text-lg">
            Tennis Club
          </span>
          <Button
            ref={closeRef}
            type="button"
            aria-label="Close menu"
            onClick={closeMenu}
            variant="secondary"
            size="iconLarge"
          >
            <X aria-hidden="true" className="size-5" strokeWidth={1.8} />
          </Button>
        </div>

        <nav aria-label="Mobile navigation" className="flex-1 overflow-y-auto px-4 py-2">
          <PrimaryNavigationLink pendingPlacement="end" href="/courts" prefetch={false} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center text-sm font-medium">
            Courts
          </PrimaryNavigationLink>
          <PrimaryNavigationLink pendingPlacement="end" href="/coaching" prefetch={false} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center text-sm font-medium">
            Coaching
          </PrimaryNavigationLink>
          <PrimaryNavigationLink pendingPlacement="end" href="/pricing" prefetch={false} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center text-sm font-medium">
            Pricing
          </PrimaryNavigationLink>
          <PrimaryNavigationLink pendingPlacement="end" href="/club" prefetch={false} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center text-sm font-medium">
            Club
          </PrimaryNavigationLink>
          <PrimaryNavigationLink pendingPlacement="end" href="/contact" prefetch={false} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center text-sm font-medium">
            Contact
          </PrimaryNavigationLink>
          {isAuthenticated && canReserve && (
            <PrimaryNavigationLink pendingPlacement="end" section={["/admin", "/coach"]} href="/admin" prefetch={drawerPrefetch} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center text-sm font-medium">
              Admin
            </PrimaryNavigationLink>
          )}

          <div className="mt-2 border-t border-border pt-2">
            {isAuthenticated ? (
              <>
                <Link href="/profile" prefetch={drawerPrefetch} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center gap-2 text-sm font-medium text-primary hover:text-accent">
                  <ProfileNavigationAvatar src={avatarUrl} />
                  Profile
                </Link>
                {/* The departure guard protects unsaved Profile drafts before the unchanged action runs. */}
                <ProfileDepartureForm action={signOutAction} onSubmit={closeMenu}>
                  <SignOutButton className="flex min-h-12 w-full items-center text-left text-sm font-medium" />
                </ProfileDepartureForm>
              </>
            ) : (
              <Link href="/login" prefetch={drawerPrefetch} dismissDrawer={() => setIsOpen(false)} className="flex min-h-12 items-center text-sm font-medium text-primary hover:text-accent">
                Sign in
              </Link>
            )}
          </div>
        </nav>
      </section>
    </>
  );
}
