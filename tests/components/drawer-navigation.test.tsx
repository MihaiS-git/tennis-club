// @vitest-environment jsdom
import { Suspense, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileNavbarControls } from "@/components/mobile-navbar-menu";
import { SidebarNavigation } from "@/components/sidebar-navigation";

const navigation = vi.hoisted(() => ({ push: vi.fn(), pathname: "/admin/locations" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/app/account/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ href, onNavigate, onClick, children, scroll, replace, transitionTypes, ...props }: Omit<ComponentProps<"a">, "href"> & {
    href: string; scroll?: boolean; replace?: boolean; transitionTypes?: string[]; onNavigate?: (event: { preventDefault: () => void }) => void;
  }) => {
    void scroll; void replace; void transitionTypes;
    return <a {...props} href={href} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate?.({ preventDefault() {} });
  }}>{children}</a>;
  },
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

// router.push returns void. Its React update suspends until the destination settles,
// even when redirects or cancellation leave the final pathname unchanged.
// `focusAtCommit` is read in the commit that reveals the destination, before passive
// effects run: the first state the browser can observe after the drawer is hidden.
const commit = { focus: null as Element | null };
function renderNavigation(children: ReactNode) {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let ready = false;
  commit.focus = null;
  function Destination({ navigating }: { navigating: boolean }) {
    if (navigating && !ready) throw gate;
    useLayoutEffect(() => { if (navigating) commit.focus = document.activeElement; }, [navigating]);
    return <p>Current page</p>;
  }
  function App() {
    const [navigating, setNavigating] = useState(false);
    navigation.push.mockImplementation(() => { setNavigating(true); });
    return <Suspense fallback="Loading destination">{children}<Destination navigating={navigating} /></Suspense>;
  }
  render(<App />);
  return async () => { await act(async () => { ready = true; finish(); }); };
}

for (const kind of ["navbar", "sidebar"] as const) {
  const content = kind === "navbar" ? <MobileNavbarControls isAuthenticated canReserve />
    : <SidebarNavigation title="Management" entries={[{ label: "Admin", href: "/admin" }, { label: "Users", href: "/admin/users" }]} />;
  const triggerName = kind === "navbar" ? "Open menu" : "Management menu";
  it(`${kind} closes after a same-path navigation settles, including repeated activation`, async () => {
    const settle = renderNavigation(content);
    const trigger = screen.getByRole("button", { name: triggerName });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    const admin = within(dialog).getByRole("link", { name: "Admin" });
    admin.focus(); fireEvent.click(admin);
    expect(navigation.push).toHaveBeenCalledWith("/admin");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(admin.querySelector("svg.motion-safe\\:animate-spin")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Admin" })).toBe(admin);
    expect(within(admin).queryByRole("status")).toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    // The same link may be activated again while pending; dismissal must still settle.
    fireEvent.click(admin);
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus must not remain on the activated link once the drawer is hidden/inert.
    expect(commit.focus).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
    expect(navigation.pathname).toBe("/admin/locations");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });
  it(`${kind} leaves modified clicks to native navigation`, () => {
    renderNavigation(content);
    fireEvent.click(screen.getByRole("button", { name: triggerName }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Admin" }), { ctrlKey: true });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
}

it("dismisses the navbar on history navigation and restores its scroll lock", () => {
  renderNavigation(<MobileNavbarControls isAuthenticated canReserve />);
  const trigger = screen.getByRole("button", { name: "Open menu" });
  fireEvent.click(trigger);
  fireEvent.popState(window);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(trigger);
});

it("releases focus from the navbar drawer when a desktop viewport hides its trigger", () => {
  const desktop = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => desktop);
  renderNavigation(<MobileNavbarControls isAuthenticated canReserve />);
  const trigger = screen.getByRole("button", { name: "Open menu" });
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog");
  expect(drawer.contains(document.activeElement)).toBe(true);
  // At lg the mobile header is display:none, so the trigger cannot take focus.
  vi.spyOn(trigger, "focus").mockImplementation(() => {});
  act(() => { desktop.matches = true; desktop.dispatchEvent(Object.assign(new Event("change"), { matches: true })); });
  expect(drawer.getAttribute("aria-hidden")).toBe("true");
  expect(drawer.contains(document.activeElement)).toBe(false);
  expect(document.body.style.overflow).toBe("");
  vi.unstubAllGlobals();
});
