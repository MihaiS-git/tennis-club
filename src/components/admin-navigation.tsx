"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, CreditCard, MapPin, Menu, Users, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

const linkClass = (active: boolean) =>
  `flex min-h-11 items-center gap-3 rounded-control px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-muted hover:text-primary"}`;

export function AdminNavigation({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  // A new destination (including Back/Forward) closes the drawer. No route state is stored.
  return (
    <ManagementNavigation
      key={pathname}
      pathname={pathname}
      isAdmin={isAdmin}
    />
  );
}

function ManagementNavigation({
  pathname,
  isAdmin,
}: {
  pathname: string;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const matches = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const closeDrawer = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    const desktop = window.matchMedia?.("(min-width: 1024px)");
    const resize = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      // Both mobile controls disappear at lg; destinations remain visible.
      if (document.activeElement === close.current || document.activeElement === trigger.current) {
        const destination = navigation.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]')
          ?? navigation.current?.querySelector<HTMLAnchorElement>("a[href]");
        destination?.focus();
      }
      setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    desktop?.addEventListener("change", resize);
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop?.removeEventListener("change", resize);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (!open || event.key !== "Tab") return;
    const elements = event.currentTarget.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function destination(
    label: string,
    href: string,
    active: boolean,
    Icon?: typeof MapPin,
  ) {
    return (
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={linkClass(active)}
        onClick={(event) => {
          if (!event.defaultPrevented) closeDrawer();
        }}
      >
        {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
        {label}
      </Link>
    );
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls={id}
        className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-4 text-sm font-semibold text-primary lg:hidden"
      >
        <Menu aria-hidden="true" className="size-5" />
        Management menu
      </button>
      {open && (
        <button
          type="button"
          aria-label="Close management backdrop"
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeDrawer}
          className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px] lg:hidden"
        />
      )}
      <aside
        id={id}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? "Management menu" : undefined}
        onKeyDown={trapFocus}
        className={`${open ? "fixed inset-y-0 left-0 z-50 block h-dvh w-[min(90vw,320px)] overflow-y-auto" : "hidden"} border border-border bg-surface p-4 lg:sticky lg:top-24 lg:block lg:h-auto lg:w-auto lg:rounded-card`}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
            Management
          </p>
          <button
            ref={close}
            type="button"
            onClick={closeDrawer}
            aria-label="Close management menu"
            className="inline-flex size-10 items-center justify-center rounded-control border border-border-strong text-primary lg:hidden"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <nav ref={navigation} aria-label="Management navigation" className="space-y-1">
          {isAdmin &&
            destination(
              "Locations",
              "/admin/locations",
              matches("/admin/locations"),
              MapPin,
            )}
          {destination(
            "Reservations",
            "/admin/reservations",
            matches("/admin/reservations"),
            CalendarDays,
          )}
          {isAdmin && (
            <>
              <div
                className={`flex min-h-11 items-center gap-3 px-3 text-sm font-semibold ${matches("/admin/payments") ? "text-primary" : "text-muted-foreground"}`}
              >
                <CreditCard aria-hidden="true" className="size-4 shrink-0" />
                Payments
              </div>
              <div className="ml-5 space-y-1 border-l border-border pl-2">
                {destination(
                  "Transactions",
                  "/admin/payments/transactions",
                  matches("/admin/payments/transactions"),
                )}
                {destination(
                  "Settings",
                  "/admin/payments/settings",
                  matches("/admin/payments/settings"),
                )}
              </div>
              {destination(
                "Users",
                "/admin/users",
                matches("/admin/users"),
                Users,
              )}
            </>
          )}
        </nav>
      </aside>
    </>
  );
}
