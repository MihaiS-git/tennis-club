// @vitest-environment jsdom
import { type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileNavbarControls } from "@/components/mobile-navbar-menu";
import { RowLink } from "@/components/row-link";
import { SidebarNavigation } from "@/components/sidebar-navigation";

const navigation = vi.hoisted(() => ({ push: vi.fn(), pathname: "/admin/locations" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/app/account/actions", () => ({ signOutAction: vi.fn() }));
// Exposes the prefetch value each Link receives: "default" means Next's automatic prefetch.
vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ href, children, prefetch, onNavigate, scroll, replace, transitionTypes, ...props }: Omit<ComponentProps<"a">, "href"> & {
    href: string; prefetch?: boolean | null; scroll?: boolean; replace?: boolean; transitionTypes?: string[]; onNavigate?: unknown;
  }) => {
    void onNavigate; void scroll; void replace; void transitionTypes;
    return <a {...props} href={href} data-prefetch={prefetch === undefined || prefetch === null ? "default" : String(prefetch)}>{children}</a>;
  },
}));

const media = { desktop: false };
beforeEach(() => {
  media.desktop = false;
  vi.stubGlobal("matchMedia", vi.fn((query: string) => Object.assign(new EventTarget(), {
    matches: query === "(min-width: 1024px)" ? media.desktop : false, media: query, onchange: null,
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const prefetchOf = (link: HTMLElement) => link.getAttribute("data-prefetch");

it("prefetches account destinations after the drawer opens while photo routes stay unprefetched", () => {
  render(<MobileNavbarControls isAuthenticated hasMessageAccess={false} canReserve />);
  const menu = screen.getByRole("navigation", { name: "Mobile navigation", hidden: true });
  const links = within(menu).getAllByRole("link", { hidden: true });
  expect(links.map(link => link.getAttribute("href"))).toEqual(["/courts", "/coaching", "/club", "/admin", "/profile"]);
  expect(links.map(prefetchOf)).toEqual(["false", "false", "false", "false", "false"]);

  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  expect(within(menu).getAllByRole("link").map(prefetchOf)).toEqual(["false", "false", "false", "default", "default"]);

  fireEvent.click(within(screen.getByRole("dialog", { name: "Mobile navigation menu" })).getByRole("button", { name: "Close menu" }));
  expect(within(menu).getAllByRole("link", { hidden: true }).map(prefetchOf)).toEqual(["false", "false", "false", "false", "false"]);
});

it("keeps the visible signed-out Sign in link off until the drawer opens", () => {
  render(<MobileNavbarControls isAuthenticated={false} canReserve={false} />);
  const menu = screen.getByRole("navigation", { name: "Mobile navigation", hidden: true });
  expect(prefetchOf(within(menu).getByRole("link", { name: "Sign in", hidden: true }))).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  expect(prefetchOf(within(menu).getByRole("link", { name: "Sign in" }))).toBe("default");
});

const entries = [{ label: "Locations", href: "/admin/locations" }, { label: "Users", href: "/admin/users" }];

it("prefetches sidebar destinations at desktop width, where the sidebar is visible", () => {
  media.desktop = true;
  render(<SidebarNavigation title="Management" entries={entries} />);
  const links = within(screen.getByRole("navigation", { name: "Management navigation" })).getAllByRole("link");
  expect(links.map(prefetchOf)).toEqual(["default", "default"]);
});

it("defers prefetching of a closed mobile sidebar drawer until it is opened", () => {
  render(<SidebarNavigation title="My account" entries={entries} slideIn />);
  const nav = screen.getByRole("navigation", { name: "My account navigation" });
  expect(within(nav).getAllByRole("link").map(prefetchOf)).toEqual(["false", "false"]);
  fireEvent.click(screen.getByRole("button", { name: "My account menu" }));
  expect(within(nav).getAllByRole("link").map(prefetchOf)).toEqual(["default", "default"]);
});

it("prefetches a record link on pointer, touch or keyboard intent and keeps caller handlers", () => {
  const onFocus = vi.fn();
  render(<ul>
    <li><RowLink href="/admin/users/1">One</RowLink></li>
    <li><RowLink href="/admin/users/2">Two</RowLink></li>
    <li><RowLink href="/admin/users/3" onFocus={onFocus}>Three</RowLink></li>
  </ul>);
  const [one, two, three] = screen.getAllByRole("link");
  expect([one, two, three].map(prefetchOf)).toEqual(["false", "false", "false"]);

  fireEvent.mouseEnter(one);
  fireEvent.touchStart(two);
  fireEvent.focus(three);
  expect([one, two, three].map(prefetchOf)).toEqual(["default", "default", "default"]);
  expect(onFocus).toHaveBeenCalledOnce();
});
