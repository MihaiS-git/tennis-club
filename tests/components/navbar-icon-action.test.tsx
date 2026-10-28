// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavbarIconAction } from "@/components/navbar-icon-action";
import { NotificationBell } from "@/components/notification-bell";
import { ProfileNavigationAvatar } from "@/components/profile-navigation-avatar";

const navigation = vi.hoisted(() => ({ pendingHref: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/courts", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", async () => {
  const { createContext, useContext } = await import("react");
  const Href = createContext("");
  return {
    default: ({ href, onNavigate, transitionTypes, children, ...props }: ComponentProps<"a"> & { onNavigate?: unknown; transitionTypes?: string[] }) => {
      void onNavigate; void transitionTypes;
      return <Href.Provider value={href ?? ""}><a href={href} {...props}>{children}</a></Href.Provider>;
    },
    useLinkStatus: () => ({ pending: useContext(Href) === navigation.pendingHref }),
  };
});

beforeEach(() => {
  navigation.pendingHref = "";
  vi.stubGlobal("matchMedia", vi.fn((query: string) => Object.assign(new EventTarget(), {
    matches: true, media: query, onchange: null,
  })));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unreadCount: 0 }) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function controls() {
  return <><NotificationBell viewport="desktop" />
    <NavbarIconAction href="/profile" aria-label="Profile" variant="avatar"><ProfileNavigationAvatar src={null} /></NavbarIconAction>
  </>;
}

it.each(["/messages", "/profile"])("keeps icon controls stable and shows feedback only for %s", async href => {
  const { rerender } = render(controls());
  const links = screen.getAllByRole("link");
  const classes = links.map(link => link.className);
  expect(links[0].className).toContain("size-10");
  expect(links[1].className).toContain("size-12 rounded-full");
  expect(document.querySelector("svg.motion-safe\\:animate-spin")).toBeNull();
  for (const link of links) {
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(link.hasAttribute("tabindex")).toBe(false);
  }
  navigation.pendingHref = href;
  rerender(controls());
  expect(links.map(link => link.className)).toEqual(classes);
  expect(document.querySelectorAll("svg.motion-safe\\:animate-spin")).toHaveLength(1);
  const spinner = document.querySelector("svg.motion-safe\\:animate-spin")!;
  expect(spinner.closest("a")?.getAttribute("href")).toBe(href);
  expect(spinner.closest('span[aria-hidden="true"]')?.className).toContain("absolute left-1/2 top-full");
  expect(screen.queryByRole("status")).toBeNull();
  navigation.pendingHref = "";
  rerender(controls());
  expect(document.querySelector("svg.motion-safe\\:animate-spin")).toBeNull();
  await act(async () => {});
});

it("preserves the unread dot and label through pending navigation and clears them on refresh", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ unreadCount: 2 })));
  const { rerender } = render(controls());
  const bell = await screen.findByRole("link", { name: "Notifications, unread messages" });
  const dot = bell.querySelector("span.rounded-full")!;
  expect(dot.getAttribute("aria-hidden")).toBe("true");
  navigation.pendingHref = "/messages";
  rerender(controls());
  expect(bell.querySelector("span.rounded-full")).toBe(dot);
  expect(bell.querySelector("svg.motion-safe\\:animate-spin")).not.toBeNull();
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ unreadCount: 0 })));
  await act(async () => { window.dispatchEvent(new Event("messages:changed")); });
  expect(screen.getByRole("link", { name: "Notifications" })).toBe(bell);
  expect(bell.querySelector("span.rounded-full")).toBeNull();
});

it("keeps the profile control geometry when an avatar fails", () => {
  render(<NavbarIconAction href="/profile" aria-label="Profile" variant="avatar"><ProfileNavigationAvatar src="/profile/avatar?v=1" /></NavbarIconAction>);
  const link = screen.getByRole("link", { name: "Profile" });
  const classes = link.className;
  const image = link.querySelector("img")!;
  expect(image.getAttribute("width")).toBe("48");
  expect(image.getAttribute("height")).toBe("48");
  expect(image.className).toContain("rounded-full object-cover");
  const frame = image.parentElement!;
  expect(frame.className).toContain("size-12");
  fireEvent.error(image);
  expect(link.querySelector("img")).toBeNull();
  expect(link.querySelector("svg")?.getAttribute("class")).toContain("size-5");
  expect(link.className).toBe(classes);
  expect(frame.className).toContain("size-12");
  expect(link.querySelector("svg")?.parentElement).toBe(frame);
});
