import Link from "next/link";

import { signOutAction } from "@/app/account/actions";
import { readNavigationProfile } from "@/lib/profile/navigation";
import { ProfileNavigationAvatar } from "./profile-navigation-avatar";

export async function DesktopNavbar() {
  const { account, avatarUrl } = await readNavigationProfile();
  const isAuthenticated = account.state !== "unauthenticated";
  const isAdmin = account.state === "active" && account.roles.includes("admin");

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
          {isAuthenticated && (
            <Link className="text-sm font-medium text-foreground hover:text-accent" href="/matches">
              Matches
            </Link>
          )}
          <Link className="text-sm font-medium text-foreground hover:text-accent" href="/rankings">
            Rankings
          </Link>
          <Link className="text-sm font-medium text-foreground hover:text-accent" href="/club">
            Club
          </Link>
          {isAdmin && (
            <Link className="text-sm font-medium text-foreground hover:text-accent" href="/admin/users">
              Users
            </Link>
          )}
        </nav>

        <div className="flex items-center justify-end gap-2 xl:gap-4">
          {!isAuthenticated && (
            <Link className="text-sm font-medium text-primary hover:text-accent" href="/login">
              Sign in
            </Link>
          )}
          <Link
            href="/book"
            className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
          >
            Book a court
          </Link>
          {isAuthenticated && (
            <>
              <ProfileNavigationAvatar src={avatarUrl} desktop />
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="whitespace-nowrap rounded-control px-1 py-2 text-sm font-medium text-primary hover:text-accent"
                >
                  Sign out
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
