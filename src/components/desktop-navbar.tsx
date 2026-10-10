import { ProfileDepartureLink as Link } from "./profile-departure-navigation";
import { Suspense } from "react";

import { readNavigationProfile } from "@/lib/profile/navigation";
import { AccountMenu } from "./account-menu";

async function AccountNavigationLink({ admin = false }: { admin?: boolean }) {
  const { account } = await readNavigationProfile();
  const visible = admin
    ? account.state === "active" && account.roles.includes("admin")
    : account.state !== "unauthenticated";
  if (!visible) return null;

  return (
    <Link className="text-sm font-medium text-foreground hover:text-accent" href={admin ? "/admin/locations" : "/matches"}>
      {admin ? "Admin" : "Matches"}
    </Link>
  );
}

async function ReservationNavigationLink() {
  const { account } = await readNavigationProfile();
  if (account.state !== "active" || !account.roles.some((role) => role === "admin" || role === "coach")) return null;
  return <Link className="text-sm font-medium text-foreground hover:text-accent" href="/reservations">Reservations</Link>;
}

async function AccountControls({ authenticated }: { authenticated: boolean }) {
  const { account, avatarUrl } = await readNavigationProfile();
  const isAuthenticated = account.state !== "unauthenticated";
  if (isAuthenticated !== authenticated) return null;

  if (!authenticated) return <Link className="text-sm font-medium text-primary hover:text-accent" href="/login">Sign in</Link>;

  return <AccountMenu avatarUrl={avatarUrl} />;
}

export function DesktopNavbar() {
  return (
    <header className="sticky top-0 z-30 hidden w-full border-b border-border bg-surface lg:block">
      <div className="mx-auto grid h-18 max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-6 xl:gap-8 xl:px-8">
        <Link
          href="/"
          className="w-fit font-heading text-lg font-semibold tracking-tight text-primary hover:text-accent xl:text-xl"
        >
          Tennis Club
        </Link>

        <nav aria-label="Main navigation" className="flex items-center gap-4 xl:gap-7">
          <Link className="text-sm font-medium text-foreground hover:text-accent" href="/courts">
            Courts
          </Link>
          <Link className="text-sm font-medium text-foreground hover:text-accent" href="/coaching">
            Coaching
          </Link>
          <Suspense fallback={<span aria-hidden="true" className="h-5 w-14 rounded-control bg-surface-muted" />}>
            <AccountNavigationLink />
          </Suspense>
          <Link className="text-sm font-medium text-foreground hover:text-accent" href="/rankings">
            Rankings
          </Link>
          <Link className="text-sm font-medium text-foreground hover:text-accent" href="/club">
            Club
          </Link>
          <Suspense fallback={<span aria-hidden="true" className="h-5 w-10 rounded-control bg-surface-muted" />}>
            <AccountNavigationLink admin />
          </Suspense>
          <Suspense fallback={null}><ReservationNavigationLink /></Suspense>
        </nav>

        <div className="flex items-center justify-end gap-2 xl:gap-4">
          <Suspense fallback={<span aria-hidden="true" className="h-5 w-12 rounded-control bg-surface-muted" />}>
            <AccountControls authenticated={false} />
          </Suspense>
          <Link
            href="/book"
            className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
          >
            Book a court
          </Link>
          <Suspense fallback={<span aria-hidden="true" className="h-9 w-24 rounded-control bg-surface-muted" />}>
            <AccountControls authenticated />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
