import { ProfileDepartureForm, ProfileDepartureLink as Link } from "./profile-departure-navigation";
import { Suspense } from "react";

import { signOutAction } from "@/app/account/actions";

import { readNavigationProfile } from "@/lib/profile/navigation";
import { PrimaryNavigationLink } from "./primary-navigation-link";
import { ProfileNavigationAvatar } from "./profile-navigation-avatar";

async function AccountNavigationLink({ admin = false }: { admin?: boolean }) {
  const { account } = await readNavigationProfile();
  const visible = admin
    ? account.state === "active" && account.roles.some((role) => role === "admin" || role === "coach")
    : account.state !== "unauthenticated";
  if (!visible) return null;

  return (
    <PrimaryNavigationLink className="inline-flex min-h-10 items-center text-sm font-medium" section={admin ? "/admin" : "/matches"} href={admin ? "/admin" : "/matches"}>
      {admin ? "Admin" : "Matches"}
    </PrimaryNavigationLink>
  );
}

async function AccountControls({ authenticated }: { authenticated: boolean }) {
  const { account, avatarUrl } = await readNavigationProfile();
  const isAuthenticated = account.state !== "unauthenticated";
  if (isAuthenticated !== authenticated) return null;

  if (!authenticated) return <Link className="text-sm font-medium text-primary hover:text-accent" href="/login">Sign in</Link>;

  return <>
    <Link href="/profile" aria-label="Profile"
      className="inline-flex min-h-10 items-center rounded-control border border-border-strong px-1.5 text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
      <ProfileNavigationAvatar src={avatarUrl} desktop />
    </Link>
    {/* The departure guard protects unsaved Profile drafts before the unchanged action runs. */}
    <ProfileDepartureForm action={signOutAction}>
      <button type="submit" className="inline-flex min-h-10 items-center whitespace-nowrap text-sm font-medium text-primary hover:text-accent">
        Sign out
      </button>
    </ProfileDepartureForm>
  </>;
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

        <nav aria-label="Main navigation" className="flex items-center gap-1 xl:gap-3">
          <PrimaryNavigationLink className="inline-flex min-h-10 items-center text-sm font-medium" href="/courts">
            Courts
          </PrimaryNavigationLink>
          <PrimaryNavigationLink className="inline-flex min-h-10 items-center text-sm font-medium" href="/coaching">
            Coaching
          </PrimaryNavigationLink>
          <Suspense fallback={<span aria-hidden="true" className="h-5 w-14 rounded-control bg-surface-muted" />}>
            <AccountNavigationLink />
          </Suspense>
          <PrimaryNavigationLink className="inline-flex min-h-10 items-center text-sm font-medium" href="/rankings">
            Rankings
          </PrimaryNavigationLink>
          <PrimaryNavigationLink className="inline-flex min-h-10 items-center text-sm font-medium" href="/club">
            Club
          </PrimaryNavigationLink>
          <Suspense fallback={<span aria-hidden="true" className="h-5 w-10 rounded-control bg-surface-muted" />}>
            <AccountNavigationLink admin />
          </Suspense>
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
