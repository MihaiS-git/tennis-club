import { Suspense } from "react";
import { AdminNavigation } from "./admin-navigation";
import { UserNavigation } from "./user-navigation";

function SidebarShell({ navigation, children }: { navigation: React.ReactNode; children: React.ReactNode }) {
  return <main className="flex-1 bg-background">
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-8 lg:px-8 lg:py-10">
      {navigation}
      <div className="min-w-0">{children}</div>
    </div>
  </main>;
}

export function ManagementShell({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
  return <SidebarShell navigation={<AdminNavigation isAdmin={isAdmin} />}>{children}</SidebarShell>;
}

// Shared by the /my-activity and /profile layouts. Each page authorizes its own account.
export function UserAreaShell({ children }: { children: React.ReactNode }) {
  return <SidebarShell navigation={<Suspense fallback={<p role="status" className="mb-5 text-sm text-muted-foreground">Loading account navigation…</p>}>
    <UserNavigation />
  </Suspense>}>{children}</SidebarShell>;
}
