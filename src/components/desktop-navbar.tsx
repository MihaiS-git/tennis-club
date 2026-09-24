import Link from "next/link";
import { UserRound } from "lucide-react";

import { signOutAction } from "@/app/account/actions";
import { readCurrentAccount } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";

export async function DesktopNavbar() {
  const supabase = await createClient();
  const account = await readCurrentAccount(supabase);
  const isAuthenticated = account.state !== "unauthenticated";

  return (
    <header className="hidden w-full border-b border-border bg-surface lg:block">
      <div className="mx-auto grid h-18 max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-6 xl:gap-8 xl:px-8">
        <Link
          href="/"
          className="w-fit font-heading text-lg font-semibold tracking-tight text-primary hover:text-primary-hover xl:text-xl"
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
              <Link
                href="/account"
                aria-label="Your account"
                className="inline-flex size-10 items-center justify-center rounded-control border border-border-strong text-primary hover:bg-surface-muted"
              >
                <UserRound aria-hidden="true" className="size-5" strokeWidth={1.8} />
              </Link>
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
