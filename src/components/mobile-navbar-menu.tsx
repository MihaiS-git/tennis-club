"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { signOutAction } from "@/app/account/actions";

export function MobileNavbarMenu({ isAuthenticated, isAdmin }: { isAuthenticated: boolean; isAdmin: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setIsOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    const desktopViewport = window.matchMedia?.("(min-width: 1024px)");
    function closeOnDesktop(event: MediaQueryListEvent) {
      if (event.matches) setIsOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    desktopViewport?.addEventListener("change", closeOnDesktop);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      desktopViewport?.removeEventListener("change", closeOnDesktop);
      document.body.style.overflow = previousOverflow;
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
    <header className="w-full border-b border-border bg-surface lg:hidden">
      <div className="flex h-16 items-center justify-between gap-2 px-4">
        <Link
          href="/"
          className="font-heading text-base font-semibold tracking-tight text-primary hover:text-accent sm:text-lg"
        >
          Tennis Club
        </Link>

        <div className="flex items-center gap-2">
          <Link
            href="/book"
            className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-control bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-primary-hover sm:text-sm"
          >
            Book a court
          </Link>
          <button
            ref={triggerRef}
            type="button"
            aria-label={isOpen ? "Close menu" : "Open menu"}
            aria-controls={menuId}
            aria-expanded={isOpen}
            onClick={() => isOpen ? closeMenu() : setIsOpen(true)}
            className="inline-flex size-10 items-center justify-center rounded-control border border-border-strong text-primary hover:bg-surface-muted"
          >
            <Menu aria-hidden="true" className="size-5" strokeWidth={1.8} />
          </button>
        </div>
      </div>

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
          <button
            ref={closeRef}
            type="button"
            aria-label="Close menu"
            onClick={closeMenu}
            className="inline-flex size-10 items-center justify-center rounded-control border border-border-strong text-primary hover:bg-surface-muted"
          >
            <X aria-hidden="true" className="size-5" strokeWidth={1.8} />
          </button>
        </div>

        <nav aria-label="Mobile navigation" className="flex-1 overflow-y-auto px-4 py-2">
          <Link onClick={closeMenu} href="/courts" className="flex min-h-12 items-center text-sm font-medium text-foreground hover:text-accent">
            Courts
          </Link>
          <Link onClick={closeMenu} href="/coaching" className="flex min-h-12 items-center text-sm font-medium text-foreground hover:text-accent">
            Coaching
          </Link>
          {isAuthenticated && (
            <Link onClick={closeMenu} href="/matches" className="flex min-h-12 items-center text-sm font-medium text-foreground hover:text-accent">
              Matches
            </Link>
          )}
          <Link onClick={closeMenu} href="/rankings" className="flex min-h-12 items-center text-sm font-medium text-foreground hover:text-accent">
            Rankings
          </Link>
          <Link onClick={closeMenu} href="/club" className="flex min-h-12 items-center text-sm font-medium text-foreground hover:text-accent">
            Club
          </Link>
          {isAdmin && (
            <Link onClick={closeMenu} href="/admin/users" className="flex min-h-12 items-center text-sm font-medium text-foreground hover:text-accent">
              Users
            </Link>
          )}

          <div className="mt-2 border-t border-border pt-2">
            {isAuthenticated ? (
              <>
                <Link onClick={closeMenu} href="/account" className="flex min-h-12 items-center text-sm font-medium text-primary hover:text-accent">
                  Account
                </Link>
                <form action={signOutAction}>
                  <button type="submit" className="flex min-h-12 w-full items-center text-left text-sm font-medium text-primary hover:text-accent">
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link onClick={closeMenu} href="/login" className="flex min-h-12 items-center text-sm font-medium text-primary hover:text-accent">
                Sign in
              </Link>
            )}
          </div>
        </nav>
      </section>
    </header>
  );
}
