import { Suspense } from "react";
import { AdminNavigation } from "./admin-navigation";
import { LoadingStatus } from "./loading-status";
import { UserNavigation } from "./user-navigation";

export function AreaShell({ navigation, children }: { navigation?: React.ReactNode; children: React.ReactNode }) {
  return <main className="flex-1 bg-background">
    <div className={`mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-10 ${navigation ? "lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-8" : ""}`}>
      {navigation}
      <div className="min-w-0">{children}</div>
    </div>
  </main>;
}

export function ManagementShell({ isAdmin, isCoach = false, children }: { isAdmin: boolean; isCoach?: boolean; children: React.ReactNode }) {
  return <AreaShell navigation={<AdminNavigation isAdmin={isAdmin} isCoach={isCoach} />}>{children}</AreaShell>;
}

// Shown while a management layout authorizes. Keeps the main area and sidebar column in
// place without any role-specific links or page content. The page height is unknown
// until then, so the footer stays unpainted (globals.css) rather than visibly moving.
export function ManagementShellFallback() {
  return <AreaShell navigation={<div aria-hidden="true" data-defers-footer="" className="mb-5 h-11 lg:sticky lg:top-24 lg:mb-0 lg:h-72 lg:rounded-card lg:border lg:border-border lg:bg-surface" />}>
    <LoadingStatus variant="page" label="Loading management area…" />
  </AreaShell>;
}

// Shared by the /my-activity and /profile layouts. Each page authorizes its own account.
export function UserAreaShell({ children }: { children: React.ReactNode }) {
  return <AreaShell navigation={<Suspense fallback={<LoadingStatus label="Loading account navigation…" className="mb-5" />}>
    <UserNavigation />
  </Suspense>}>{children}</AreaShell>;
}
