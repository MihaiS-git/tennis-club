import { ProfileDepartureLink as Link } from "./profile-departure-navigation";
import { readNavigationProfile } from "@/lib/profile/navigation";
import { MobileNavbarMenu } from "./mobile-navbar-menu";

export function MobileNavbarFallback() {
  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-surface lg:hidden">
      <div className="flex h-16 items-center justify-between gap-2 px-4">
        <Link href="/" className="font-heading text-base font-semibold tracking-tight text-primary hover:text-accent sm:text-lg">Tennis Club</Link>
        <div className="flex items-center gap-2">
          <Link href="/book" className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-control bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-primary-hover sm:text-sm">Book a court</Link>
          <span aria-hidden="true" className="size-10 rounded-control border border-border bg-surface-muted" />
        </div>
      </div>
    </header>
  );
}

export async function MobileNavbar() {
  const { account, avatarUrl } = await readNavigationProfile();

  return (
    <MobileNavbarMenu
      isAuthenticated={account.state !== "unauthenticated"}
      isAdmin={account.state === "active" && account.roles.includes("admin")}
      avatarUrl={avatarUrl}
    />
  );
}
