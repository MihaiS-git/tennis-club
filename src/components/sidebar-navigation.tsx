"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export type SidebarLink = { label: string; href: string; icon?: LucideIcon; exact?: boolean };
export type SidebarGroup = { label: string; icon?: LucideIcon; links: readonly SidebarLink[] };
export type SidebarEntry = SidebarLink | SidebarGroup;
type SidebarSection = { label: string; entries: readonly SidebarEntry[] };

// A page with unsaved Profile edits renders [data-profile-unsaved]; mark its link and the drawer trigger.
const unsavedDot = "[:root:has([data-profile-unsaved])_&]:after:ml-auto [:root:has([data-profile-unsaved])_&]:after:size-2 [:root:has([data-profile-unsaved])_&]:after:shrink-0 [:root:has([data-profile-unsaved])_&]:after:rounded-full [:root:has([data-profile-unsaved])_&]:after:bg-accent [:root:has([data-profile-unsaved])_&]:after:content-['']";
const sidebarLinkClass = (active: boolean) =>
  `flex min-h-11 items-center gap-3 rounded-control px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${active ? `bg-primary text-primary-foreground ${unsavedDot}` : "text-muted-foreground hover:bg-surface-muted hover:text-primary"}`;

// `slideIn` reuses the main mobile menu's slide transition for the mobile drawer.
type SidebarProps = { title: string; slideIn?: boolean } & (
  | { entries: readonly SidebarEntry[]; sections?: never }
  | { entries?: never; sections: readonly SidebarSection[] }
);

// Shared by the Admin and user-area sidebars: one drawer, focus and active-link model.
export function SidebarNavigation({ title, entries, sections, slideIn = false }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  // A new destination (including Back/Forward) closes the drawer, keeping the element mounted
  // so a sliding drawer can animate out. No route state is stored.
  if (openedAt !== pathname) {
    setOpenedAt(pathname);
    setOpen(false);
  }
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const name = title.toLowerCase();
  const matches = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const linkActive = ({ href, exact }: SidebarLink) => exact ? pathname === href : matches(href);
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

  function destination(link: SidebarLink) {
    const active = linkActive(link);
    const Icon = link.icon;
    return (
      <Link
        key={link.href}
        href={link.href}
        aria-current={active ? "page" : undefined}
        className={sidebarLinkClass(active)}
        onClick={(event) => {
          if (!event.defaultPrevented) closeDrawer();
        }}
      >
        {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
        {link.label}
      </Link>
    );
  }

  function group({ label, icon: Icon, links }: SidebarGroup) {
    const active = links.some(linkActive);
    return (
      <Fragment key={label}>
        <div
          className={`flex min-h-11 items-center gap-3 px-3 text-sm font-semibold ${active ? "text-primary" : "text-muted-foreground"}`}
        >
          {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
          {label}
        </div>
        <div className="ml-5 space-y-1 border-l border-border pl-2">
          {links.map(destination)}
        </div>
      </Fragment>
    );
  }

  function entry(entry: SidebarEntry) {
    return "links" in entry ? group(entry) : destination(entry);
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls={id}
        className={`mb-5 inline-flex min-h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-4 text-sm font-semibold text-primary lg:hidden ${unsavedDot}`}
      >
        <Menu aria-hidden="true" className="size-5" />
        {title} menu
      </button>
      {open && (
        <button
          type="button"
          aria-label={`Close ${name} backdrop`}
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
        aria-label={open ? `${title} menu` : undefined}
        onKeyDown={trapFocus}
        className={slideIn
          ? `border border-border bg-surface p-4 max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:h-dvh max-lg:w-[90vw] max-lg:max-w-[360px] max-lg:overflow-y-auto max-lg:border-y-0 max-lg:border-l-0 max-lg:transition-[translate,visibility] max-lg:duration-[var(--ui-duration-base)] max-lg:ease-standard motion-reduce:transition-none lg:sticky lg:top-24 lg:rounded-card ${open ? "translate-x-0" : "max-lg:invisible max-lg:-translate-x-full"}`
          : `${open ? "fixed inset-y-0 left-0 z-50 block h-dvh w-[min(90vw,320px)] overflow-y-auto" : "hidden"} border border-border bg-surface p-4 lg:sticky lg:top-24 lg:block lg:h-auto lg:w-auto lg:rounded-card`}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
            {title}
          </p>
          <button
            ref={close}
            type="button"
            onClick={closeDrawer}
            aria-label={`Close ${name} menu`}
            className="inline-flex size-10 items-center justify-center rounded-control border border-border-strong text-primary lg:hidden"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <nav ref={navigation} aria-label={`${title} navigation`} className="space-y-1">
          {sections ? sections.filter((section) => section.entries.length > 0).map((section, index) => (
            <section key={section.label} aria-labelledby={`${id}-section-${index}`} className="space-y-1 not-first:mt-5">
              <h2 id={`${id}-section-${index}`} className="mb-2 px-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {section.label}
              </h2>
              {section.entries.map(entry)}
            </section>
          )) : entries.map(entry)}
        </nav>
      </aside>
    </>
  );
}
