import { AdminNavigation } from "./admin-navigation";

export function ManagementShell({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
  return <main className="flex-1 bg-background">
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-8 lg:px-8 lg:py-10">
      <AdminNavigation isAdmin={isAdmin} />
      <div className="min-w-0">{children}</div>
    </div>
  </main>;
}
