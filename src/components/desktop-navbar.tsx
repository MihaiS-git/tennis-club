import { ProfileDepartureForm, ProfileDepartureLink as Link } from "./profile-departure-navigation";
import { Suspense } from "react";

import { NotificationBell } from "./notification-bell";
import { SignOutButton } from "./sign-out-button";

import { signOutAction } from "@/app/account/actions";

import { readNavigationProfile } from "@/lib/profile/navigation";
import { PrimaryNavigationLink } from "./primary-navigation-link";
import { BookCourtLink } from "./book-court-link";
import { ProfileNavigationAvatar } from "./profile-navigation-avatar";

async function AdminNavigationLink() {
  const { account } = await readNavigationProfile();
  const visible = account.state === "active" && account.roles.some((role) => role === "admin" || role === "coach");
  if (!visible) return null;

  return (
    <PrimaryNavigationLink className="inline-flex min-h-10 items-center text-sm font-medium" section="/admin" href="/admin">
      Admin
    </PrimaryNavigationLink>
  );
}

async function AccountControls({ authenticated }: { authenticated: boolean }) {
  const { account, avatarUrl } = await readNavigationProfile();
  const isAuthenticated = account.state !== "unauthenticated";
  if (isAuthenticated !== authenticated) return null;

  if (!authenticated) return <Link className="text-sm font-medium text-primary hover:text-accent" href="/login">Sign in</Link>;

  return <>
    <NotificationBell admin={account.state === "active" && account.roles.includes("admin")} />
    <Link href="/profile" aria-label="Profile"
      className="inline-flex min-h-10 items-center rounded-control border border-border-strong px-1.5 text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
      <ProfileNavigationAvatar src={avatarUrl} desktop />
    </Link>
    {/* The departure guard protects unsaved Profile drafts before the unchanged action runs. */}
    <ProfileDepartureForm action={signOutAction}>
      <SignOutButton className="inline-flex min-h-10 items-center whitespace-nowrap text-sm font-medium text-primary" />
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
          <PrimaryNavigationLink className="inline-flex min-h-10 items-center text-sm font-medium" href="/club">
            Club
          </PrimaryNavigationLink>
          <Suspense fallback={<span aria-hidden="true" className="h-5 w-10 rounded-control bg-surface-muted" />}>
            <AdminNavigationLink />
          </Suspense>
        </nav>

        <div className="flex items-center justify-end gap-2 xl:gap-4">
          <Suspense fallback={<span aria-hidden="true" className="h-5 w-12 rounded-control bg-surface-muted" />}>
            <AccountControls authenticated={false} />
          </Suspense>
          <BookCourtLink
            className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
          />
          <Suspense fallback={<span aria-hidden="true" className="h-9 w-24 rounded-control bg-surface-muted" />}>
            <AccountControls authenticated />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
