import { AdminNavigation } from "@/components/admin-navigation";
import { requireActiveAdmin } from "@/lib/admin/authorization";

export const instant = false;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminAuthorizedShell>{children}</AdminAuthorizedShell>;
}

async function AdminAuthorizedShell({ children }: { children: React.ReactNode }) {
  await requireActiveAdmin();

  return (
    <main className="flex-1 bg-background">
      <div className="mx-auto max-w-7xl px-6 py-10 md:px-8 md:py-12 lg:py-16">
        <AdminNavigation />
        {children}
      </div>
    </main>
  );
}
